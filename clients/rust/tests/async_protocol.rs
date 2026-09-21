#![cfg(feature = "async")]
use agenticdriver::{AsyncAgenticClient, Error, RunRequest};
use serde_json::Value;
use std::io::{Read, Write};
use std::net::TcpListener;
use std::thread;
use std::time::Duration;

#[tokio::test]
async fn shared_version_fixtures() {
    let fixture: Value =
        serde_json::from_str(include_str!("../../../protocol/fixtures/versioning.json")).unwrap();
    for case in fixture["cases"].as_array().unwrap() {
        let example = case.clone();
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let server = thread::spawn(move || {
            let (mut socket, _) = listener.accept().unwrap();
            socket
                .set_read_timeout(Some(Duration::from_secs(5)))
                .unwrap();
            let mut request = Vec::new();
            let mut byte = [0u8; 1];
            while !request.ends_with(b"\r\n\r\n") {
                socket.read_exact(&mut byte).unwrap();
                request.push(byte[0]);
            }
            let headers = String::from_utf8(request).unwrap().to_lowercase();
            assert!(headers.contains("agenticdriver-version: 1.0\r\n"));
            assert!(headers.contains("agenticdriver-accept-optional-events: true\r\n"));
            let length = headers
                .lines()
                .find_map(|line| line.strip_prefix("content-length: "))
                .unwrap()
                .parse::<usize>()
                .unwrap();
            let mut input = vec![0; length];
            socket.read_exact(&mut input).unwrap();
            let body = if let Some(events) = example["events"].as_array() {
                events
                    .iter()
                    .map(|event| format!("data: {}\n\n", event))
                    .collect::<String>()
            } else {
                example["json"].to_string()
            };
            let status = example["status"].as_u64().unwrap_or(200);
            let mut response = format!("HTTP/1.1 {} Test\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n", status, body.len());
            for (key, value) in example["headers"].as_object().unwrap() {
                response.push_str(&format!("{}: {}\r\n", key, value.as_str().unwrap()));
            }
            response.push_str("\r\n");
            response.push_str(&body);
            socket.write_all(response.as_bytes()).unwrap();
        });
        let client = AsyncAgenticClient::new(&url, "fixture-token").unwrap();
        let mut types = Vec::new();
        let result = async {
            let mut stream = client
                .stream(&RunRequest::new("mock", "demo", "Hello"))
                .await?;
            while let Some(event) = stream.next().await {
                let event = event?;
                types.push(event.kind);
                if let Some(error) = event.error {
                    return Err(Error::Driver(error));
                }
            }
            Ok(())
        }
        .await;
        server.join().unwrap();
        if let Some(expected) = case["expectedError"].as_str() {
            match result {
                Err(Error::Driver(error)) => {
                    assert_eq!(error.code, expected, "{}", case["id"]);
                    assert_eq!(
                        error.retryable,
                        case["retryable"].as_bool().unwrap_or(false)
                    );
                }
                other => panic!("{}: expected {}, got {:?}", case["id"], expected, other),
            }
        } else {
            result.unwrap();
            assert_eq!(serde_json::to_value(types).unwrap(), case["expectedTypes"]);
        }
    }
}
