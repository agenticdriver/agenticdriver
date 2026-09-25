"""Run the actual language example servers against the conformance host, without model inference."""
import base64
import json
import os
from pathlib import Path
import ssl
import signal
import subprocess
import tempfile
from urllib.error import HTTPError
from urllib.parse import urlsplit
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parent.parent

def check_panel_examples(commands, environment):
    context = ssl.create_default_context(cafile=environment.get('AGENTICDRIVER_TEST_CA'))
    host = environment['AGENTICDRIVER_TEST_MANAGEMENT_URL'].rstrip('/')
    token = environment['AGENTICDRIVER_TEST_TOKEN']
    def send(url, body=None, *, bearer=None, origin=None):
        headers = {'Content-Type': 'application/json'}
        if bearer: headers['Authorization'] = 'Bearer ' + bearer
        if origin: headers['Origin'] = origin
        request = Request(url, data=None if body is None else json.dumps(body).encode(), headers=headers)
        with urlopen(request, context=context, timeout=30) as response:
            return response.read()
    for name, command, cwd in commands:
        env = dict(environment)
        if env.get('AGENTICDRIVER_TEST_CA'): env['AGENTICDRIVER_CA_FILE'] = env['AGENTICDRIVER_TEST_CA']
        else: env.pop('AGENTICDRIVER_CA_FILE', None)
        subject = name + '-panel-example'
        with tempfile.TemporaryFile(mode='w+') as errors:
            proc = subprocess.Popen(command, cwd=cwd, env=env, stdout=subprocess.PIPE, stderr=errors, text=True, start_new_session=os.name == "posix")
            try:
                # Each example emits exactly one private link; do not echo it into logs.
                line = proc.stdout.readline()
                if not line: raise AssertionError(name + ' example did not start; inspect its compile checks')
                url = json.loads(line)['url']
                assert urlsplit(url).hostname == '127.0.0.1'
                assert b'agenticdriver-providers' in send(url)
                assert b'customElements' in send(url+'panel.js')
                api = url+'api'
                state = json.loads(send(api, {'action':'snapshot'}))
                assert not state['connected'] and state['canConnect']
                try: send(api, {'action':'snapshot'}, origin='https://untrusted.example')
                except HTTPError as error: assert error.code == 403
                else: raise AssertionError('Example accepted another browser origin')
                try: send(urlsplit(url)._replace(path='/api').geturl(), {'action':'snapshot'})
                except HTTPError as error: assert error.code in [403,404]
                else: raise AssertionError('Example accepted an absent private panel path')
                invite = json.loads(send(host+'/v1/management/invitations', {'grant':{'subject':subject,'providers':['fixture'],'manageProviders':True}}, bearer=token))
                encoded = base64.urlsafe_b64encode(host.encode()).decode().rstrip('=')
                state = json.loads(send(api, {'action':'connect','invitation':f'ad1.{encoded}.{invite["code"]}'}))
                assert state['connected'] and state['canInvite']
                assert state['management']['executionProviders'] == ['fixture']
                provider = next(p for p in state['management']['providers'] if p['id']=='fixture')
                before = dict(provider)
                provider['name'] = name + ' example account'
                state = json.loads(send(api, {'action':'configure','change':{'revision':state['management']['revision'],'provider':provider}}))
                assert next(p for p in state['providers'] if p['id']=='fixture')['name'] == name + ' example account'
                state = json.loads(send(api, {'action':'configure','change':{'revision':state['management']['revision'],'provider':before}}))
                assert token not in json.dumps(state) and 'token' not in state.get('connection', {})
                assert not json.loads(send(api, {'action':'disconnect'}))['connected']
                print(f'{name} runnable provider panel: assets, private setup, remote edits and disconnect passed ({urlsplit(host).scheme}).', flush=True)
            finally:
                if os.name == 'posix':
                    try: os.killpg(proc.pid, signal.SIGTERM)
                    except ProcessLookupError: pass
                elif os.name == 'nt':
                    subprocess.run(['taskkill', '/PID', str(proc.pid), '/T', '/F'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
                else: proc.terminate()
                try: proc.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    if os.name == 'posix':
                        try: os.killpg(proc.pid, signal.SIGKILL)
                        except ProcessLookupError: pass
                    else: proc.kill()
                    proc.wait()
                connections = json.loads(send(host+'/v1/management/connections', bearer=token))
                for grant in [*connections['connections'], *connections['invitations']]:
                    if grant['grant']['subject'] == subject:
                        send(host+'/v1/management/connections/revoke', {'id':grant['id']}, bearer=token)
