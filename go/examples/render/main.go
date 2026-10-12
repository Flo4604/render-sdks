package main

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"time"

	skinicon "github.com/Flo4604/skinicon-sdks/go"
)

func main() {
	if len(os.Args) != 2 {
		fmt.Fprintln(os.Stderr, "usage: go run ./examples/render 'steam://...'")
		os.Exit(1)
	}
	client, err := skinicon.NewClient(skinicon.Config{APIKey: os.Getenv("RENDER_API_KEY")})
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	start := time.Now()
	images, err := client.Render(context.Background(), skinicon.RenderRequest{InspectURL: os.Args[1]})
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	encoder := json.NewEncoder(os.Stdout)
	encoder.SetIndent("", "  ")
	if err := encoder.Encode(images); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	fmt.Fprintf(os.Stderr, "Render completed in %s\n", time.Since(start).Round(time.Millisecond))
}
