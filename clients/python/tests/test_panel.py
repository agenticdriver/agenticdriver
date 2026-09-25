import unittest
from agenticdriver import ProviderPanel, AsyncProviderPanel, provider_panel_html, provider_panel_script


class Panel(unittest.TestCase):
    def test_packaged_component_and_connection_hooks(self):
        self.assertIn(b'agenticdriver-providers', provider_panel_script())
        self.assertIn(b'customElements', provider_panel_script())
        self.assertIn('api="/settings/driver"', provider_panel_html('/settings/driver'))
        for path in ['https://untrusted.example', '//untrusted.example', '/a/../b']:
            with self.assertRaises(ValueError): provider_panel_html(path)
        seen = []
        panel = ProviderPanel(lambda: None, connect=seen.append, disconnect=seen.clear)
        self.assertFalse(panel.handle({'action': 'snapshot'})['connected'])
        panel.handle({'action': 'connect', 'invitation': 'application-hook'})
        self.assertEqual(seen, ['application-hook'])
        panel.handle({'action': 'disconnect'})
        self.assertEqual(seen, [])


class AsyncPanel(unittest.IsolatedAsyncioTestCase):
    async def test_async_connection_hooks(self):
        seen = []
        async def connect(invitation): seen.append(invitation)
        async def disconnect(): seen.clear()
        panel = AsyncProviderPanel(lambda: None, connect=connect, disconnect=disconnect)
        await panel.handle({'action': 'connect', 'invitation': 'async-application-hook'})
        self.assertEqual(seen, ['async-application-hook'])
        await panel.handle({'action': 'disconnect'})
        self.assertFalse((await panel.snapshot())['connected'])
        self.assertEqual(seen, [])
