import re
from ._protocol import count, text, valid_timestamp, EventDecoder, EVENT_TYPES
from ._errors import DriverError

def job_id(value):
    return isinstance(value, str) and re.fullmatch(r"[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}", value) is not None

def job_date(value):
    return valid_timestamp(value) and re.fullmatch(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z", value) is not None

def valid_job(value, request=None):
    if not (isinstance(value, dict) and job_id(value.get("id")) and job_id(value.get("runId")) and
            text(value.get("provider")) and text(value.get("model")) and count(value.get("cursor")) and
            type(value.get("cancelRequested")) is bool and job_date(value.get("createdAt")) and
            job_date(value.get("updatedAt")) and value["updatedAt"] >= value["createdAt"] and
            value.get("state") in ("queued", "running", "completed", "failed", "cancelled", "interrupted")):
        return False
    terminal = value["state"] not in ("queued", "running")
    if (terminal != ("expiresAt" in value) or (terminal and (not job_date(value["expiresAt"]) or value["expiresAt"] <= value["updatedAt"] or value["cursor"] < 2)) or
            (value["state"] == "queued" and value["cursor"] != 0)):
        return False
    if request is None:
        return True
    if "id" in request:
        return value["id"] == request["id"]
    return all(value[key] == request["request"][key] for key in ("provider", "model"))

def valid_job_page(value, request):
    if not (isinstance(value, dict) and valid_job(value.get("job"), request) and isinstance(value.get("events"), list) and
            len(value["events"]) <= min(request.get("limit", 100), 100) and count(value.get("nextCursor")) and type(value.get("hasMore")) is bool):
        return False
    job = value["job"]
    decoder = EventDecoder({"provider": job["provider"], "model": job["model"]})
    decoder.sequence, decoder.run_id = request["after"], job["runId"]
    for event in value["events"]:
        if not isinstance(event, dict) or event.get("type") not in EVENT_TYPES or event["type"].startswith("approval.") or event["type"] == "tool.execution.requested":
            return False
        # There is no run selection in this lookup. Validate the stored evidence relationships
        # without inventing a new retrieval query or requiring a provider call.
        result = event.get("result")
        if isinstance(result, dict) and isinstance(result.get("retrieval"), dict):
            decoder.request["retrieval"] = {"corpus": result["retrieval"].get("corpus"), "limit": 16, "maxContextBytes": 2_000_000}
        try:
            decoder.accept(event)
        except DriverError:
            return False
        ended = event["type"] in ("run.completed", "run.failed", "run.cancelled")
        terminal = job["state"] not in ("queued", "running")
        if (decoder.sequence > job["cursor"] or (ended and (decoder.sequence != job["cursor"] or not terminal)) or
                (decoder.sequence == job["cursor"] and terminal and not ended) or
                (event["type"] == "run.completed" and job["state"] != "completed") or
                (event["type"] == "run.cancelled" and job["state"] != "cancelled") or
                (event["type"] == "run.failed" and (job["state"] not in ("failed", "interrupted") or (job["state"] == "interrupted" and event["error"].get("outcome") != "uncertain")))):
            return False
    return (value["nextCursor"] == decoder.sequence <= job["cursor"] and value["hasMore"] == (decoder.sequence < job["cursor"]) and
            (not value["hasMore"] or bool(value["events"])))
