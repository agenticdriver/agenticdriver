package main

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/signal"
	"strings"

	agenticdriver "github.com/agenticdriver/agenticdriver/clients/go"
)

func required(name string) string {
	value := os.Getenv(name)
	if value == "" {
		panic("Set " + name + "; no connection or corpus is inferred.")
	}
	return value
}
func main() {
	token, err := os.ReadFile(required("AGENTICDRIVER_TOKEN_FILE"))
	if err != nil {
		panic(err)
	}
	query, err := os.ReadFile(required("AGENTICDRIVER_QUERY_FILE"))
	if err != nil {
		panic(err)
	}
	client, err := agenticdriver.New(required("AGENTICDRIVER_URL"), strings.TrimSpace(string(token)))
	if err != nil {
		panic(err)
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt)
	defer stop()
	evidence, err := client.SearchContext(ctx, agenticdriver.RetrievalSearch{
		Corpus: required("AGENTICDRIVER_CORPUS"), SourceIDs: []string{required("AGENTICDRIVER_SOURCE_ID")},
		Query: string(query), Limit: 4,
	})
	if err != nil {
		panic(err)
	}
	data, err := json.MarshalIndent(evidence, "", "  ")
	if err != nil {
		panic(err)
	}
	fmt.Println(string(data))
}
