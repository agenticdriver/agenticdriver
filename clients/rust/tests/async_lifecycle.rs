#![cfg(feature = "async")]
use agenticdriver::{AsyncAgenticClient, Error, EventPayload, RunRequest};
use serde_json::json;
use std::time::Duration;
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpListener,
    sync::oneshot,
};

const WATCHDOG: Duration = Duration::from_secs(5);
fn request() -> RunRequest {
    RunRequest::new("mock", "demo", "Hello")
}
fn started() -> String {
    format!(
        "data: {}\r\r",
        json!({"type":"run.started","runId":"lifecycle","sequence":1,
        "timestamp":"2026-09-21T12:00:00Z","provider":"mock","model":"demo"})
    )
}

async fn read_request(socket: &mut tokio::net::TcpStream) {
    let mut headers = Vec::new();
    while !headers.ends_with(b"\r\n\r\n") {
        headers.push(socket.read_u8().await.unwrap());
    }
    let headers = String::from_utf8(headers).unwrap().to_lowercase();
    assert!(headers.contains("authorization: bearer test-only\r\n"));
    let length: usize = headers
        .lines()
        .find_map(|s| s.strip_prefix("content-length: "))
        .unwrap()
        .parse()
        .unwrap();
    let mut body = vec![0; length];
    socket.read_exact(&mut body).await.unwrap();
    assert!(serde_json::from_slice::<serde_json::Value>(&body)
        .unwrap()
        .get("idleTimeoutMs")
        .is_none());
}

// Server does not stop work until it sees the client close its response.
async fn stalled_peer(
    mode: &str,
) -> (
    AsyncAgenticClient,
    oneshot::Receiver<()>,
    tokio::task::JoinHandle<()>,
) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let client = AsyncAgenticClient::new(
        &format!("http://{}", listener.local_addr().unwrap()),
        "test-only",
    )
    .unwrap();
    let mode = mode.to_owned();
    let (ready, received) = oneshot::channel();
    let task = tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.unwrap();
        read_request(&mut socket).await;
        if mode != "headers" {
            let media = if mode == "json" {
                "application/json"
            } else {
                "text/event-stream"
            };
            socket.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: {media}\r\nTransfer-Encoding: chunked\r\n\r\n").as_bytes()).await.unwrap();
            if mode == "stream" || mode == "malformed" || mode == "terminal" {
                let mut body = started();
                if mode == "malformed" {
                    body.push_str("data: invalid\r\r");
                }
                if mode == "terminal" {
                    body.push_str(&format!("data: {}\r\r", json!({"type":"run.cancelled","runId":"lifecycle","sequence":2,
                        "timestamp":"2026-09-21T12:00:00Z","error":{"code":"CANCELLED","message":"Stopped.","retryable":false}})));
                }
                socket
                    .write_all(format!("{:x}\r\n{body}\r\n", body.len()).as_bytes())
                    .await
                    .unwrap();
            }
        }
        ready.send(()).unwrap();
        let mut byte = [0];
        match tokio::time::timeout(WATCHDOG, socket.read(&mut byte))
            .await
            .expect("Client did not close its response")
        {
            Ok(0) | Err(_) => {}
            other => panic!("Expected disconnect, got {other:?}"),
        }
    });
    (client, received, task)
}

#[tokio::test]
async fn drop_close_and_pending_next_cancel_upstream() {
    for action in ["drop", "close", "pending-next", "task-abort"] {
        let (client, received, server) = stalled_peer("stream").await;
        let mut stream = client.stream(&request()).await.unwrap();
        received.await.unwrap();
        assert!(matches!(
            stream.next().await.unwrap().unwrap().payload().unwrap(),
            EventPayload::RunStarted { .. }
        ));
        match action {
            "drop" => drop(stream),
            "close" => {
                stream.close();
                stream.close();
                assert!(stream.is_closed());
                assert!(stream.next().await.is_none());
            }
            "pending-next" => {
                assert!(
                    tokio::time::timeout(Duration::from_millis(20), stream.next())
                        .await
                        .is_err()
                );
                assert!(stream.is_closed());
                assert!(stream.next().await.is_none());
            }
            _ => {
                let (polling, polled) = oneshot::channel();
                let task = tokio::spawn(async move {
                    polling.send(()).unwrap();
                    stream.next().await
                });
                polled.await.unwrap();
                task.abort();
                assert!(task.await.unwrap_err().is_cancelled());
            }
        }
        tokio::time::timeout(WATCHDOG, server)
            .await
            .unwrap()
            .unwrap();
    }
}

#[tokio::test]
async fn cancelling_header_and_buffered_body_reads_closes_upstream() {
    for mode in ["headers", "json"] {
        let (client, received, server) = stalled_peer(mode).await;
        let task = tokio::spawn(async move { client.run(&request()).await });
        received.await.unwrap();
        task.abort();
        assert!(task.await.unwrap_err().is_cancelled());
        tokio::time::timeout(WATCHDOG, server)
            .await
            .unwrap()
            .unwrap();
    }
}

#[tokio::test]
async fn failed_decode_and_terminal_event_close_without_waiting_for_eof() {
    for mode in ["malformed", "terminal"] {
        let (client, received, server) = stalled_peer(mode).await;
        let mut stream = client.stream(&request()).await.unwrap();
        received.await.unwrap();
        stream.next().await.unwrap().unwrap();
        let next = stream.next().await.unwrap();
        if mode == "malformed" {
            assert!(matches!(next, Err(Error::Driver(e)) if e.code == "INVALID_STREAM"));
        } else {
            assert!(
                matches!(next.unwrap().payload().unwrap(), EventPayload::RunCancelled { error } if error.code == "CANCELLED")
            );
        }
        assert!(stream.is_closed());
        assert!(stream.next().await.is_none());
        tokio::time::timeout(WATCHDOG, server)
            .await
            .unwrap()
            .unwrap();
    }
}

#[tokio::test]
async fn no_default_run_deadline_with_virtual_clock() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let client = AsyncAgenticClient::new(
        &format!("http://{}", listener.local_addr().unwrap()),
        "test-only",
    )
    .unwrap();
    let (ready, received) = oneshot::channel();
    let (release, wait) = oneshot::channel();
    let server = tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.unwrap();
        read_request(&mut socket).await;
        socket.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nTransfer-Encoding: chunked\r\n\r\n").await.unwrap();
        ready.send(()).unwrap();
        wait.await.unwrap();
        let body = json!({"runId":"long","provider":"mock","model":"demo","text":"Done","usage":{},"steps":1,"finishReason":"stop"}).to_string();
        socket
            .write_all(format!("{:x}\r\n{body}\r\n0\r\n\r\n", body.len()).as_bytes())
            .await
            .unwrap();
    });
    let task = tokio::spawn(async move { client.run(&request()).await });
    received.await.unwrap();
    tokio::time::pause();
    tokio::time::advance(Duration::from_secs(3600)).await;
    tokio::task::yield_now().await;
    assert!(!task.is_finished(), "A hidden run deadline expired");
    tokio::time::resume();
    release.send(()).unwrap();
    assert_eq!(
        tokio::time::timeout(WATCHDOG, task)
            .await
            .unwrap()
            .unwrap()
            .unwrap()
            .text,
        "Done"
    );
    server.await.unwrap();
}

#[tokio::test]
async fn cancelling_one_stream_preserves_another_on_the_same_client() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let client = AsyncAgenticClient::new(
        &format!("http://{}", listener.local_addr().unwrap()),
        "test-only",
    )
    .unwrap();
    let (released, wait) = oneshot::channel();
    let server = tokio::spawn(async move {
        let (mut first, _) = listener.accept().await.unwrap();
        read_request(&mut first).await;
        let headers = b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nTransfer-Encoding: chunked\r\n\r\n";
        first.write_all(headers).await.unwrap();
        let body = started();
        first
            .write_all(format!("{:x}\r\n{body}\r\n", body.len()).as_bytes())
            .await
            .unwrap();
        let (mut second, _) = listener.accept().await.unwrap();
        read_request(&mut second).await;
        second.write_all(headers).await.unwrap();
        second
            .write_all(format!("{:x}\r\n{body}\r\n", body.len()).as_bytes())
            .await
            .unwrap();
        let mut byte = [0];
        assert_eq!(
            tokio::time::timeout(WATCHDOG, first.read(&mut byte))
                .await
                .unwrap()
                .unwrap(),
            0
        );
        released.send(()).unwrap();
        let body = format!(
            "data: {}\n\n",
            json!({"type":"run.completed","runId":"lifecycle","sequence":2,
            "timestamp":"2026-09-21T12:00:00Z","result":{"runId":"lifecycle","provider":"mock","model":"demo",
                "text":"Survived","usage":{},"steps":1,"finishReason":"stop"}})
        );
        second
            .write_all(format!("{:x}\r\n{body}\r\n0\r\n\r\n", body.len()).as_bytes())
            .await
            .unwrap();
    });
    let clone = client.clone();
    let mut first = client.stream(&request()).await.unwrap();
    let mut second = clone.stream(&request()).await.unwrap();
    first.next().await.unwrap().unwrap();
    second.next().await.unwrap().unwrap();
    drop(client);
    drop(clone);
    // An unpolled next future is inert; neither taking it nor dropping clients cancels.
    drop(second.next());
    assert!(!second.is_closed());
    first.close();
    tokio::time::timeout(WATCHDOG, wait).await.unwrap().unwrap();
    assert!(
        matches!(second.next().await.unwrap().unwrap().payload().unwrap(),
        EventPayload::RunCompleted { result } if result.text == "Survived")
    );
    assert!(second.next().await.is_none());
    server.await.unwrap();
}
