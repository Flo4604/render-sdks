package render

import (
	"strings"
	"testing"
)

func TestImageURL(t *testing.T) {
	hash := strings.Repeat("A", 43)
	for _, origin := range []string{"https://img.medalbot.cc", "http://localhost:8080", "https://images.example:8443", "http://[::1]:8080"} {
		for _, format := range []string{"webp", "png"} {
			for _, variant := range []ImageVariant{Small, Card, Zoom} {
				got, err := ImageURL(origin+"/v1/"+hash+"."+format, variant)
				want := origin + "/d/v1/" + hash + "_" + string(variant) + ".webp"
				if err != nil || got != want {
					t.Fatalf("got %q, %v; want %q", got, err, want)
				}
			}
		}
	}
}

func TestImageURLRejectsInvalidInput(t *testing.T) {
	hash := strings.Repeat("A", 43)
	original := "https://img.medalbot.cc/v1/" + hash + ".webp"
	change := func(old, new string) string { return strings.Replace(original, old, new, 1) }
	derivative, _ := ImageURL(original, Card)
	for _, value := range []string{
		"/v1/" + hash + ".webp", original + "?", original + "?w=20", original + "#", original + "#x",
		change("https:", "file:"), change("img.medalbot.cc", "user:pass@img.medalbot.cc"),
		change("img.medalbot.cc", "@img.medalbot.cc"), change("img.medalbot.cc", "img.medalbot.cc:65536"),
		change("/v1/", "/x/../v1/"), change("/v1/", "/v1%2F"), change(hash, hash[:42]+"B"), change(hash, hash+"="),
		change(".webp", ".jpg"), change(".webp", ".webp.webp"), original + "\n", " " + original,
		change("img.medalbot.cc", "img.\x00medalbot.cc"), change("img.medalbot.cc", "img.\u00a0medalbot.cc"), change("/v1/", "\\v1/"), derivative,
	} {
		if _, err := ImageURL(value, Card); err == nil {
			t.Errorf("accepted %q", value)
		}
	}
	if _, err := ImageURL(original, ImageVariant("huge")); err == nil {
		t.Error("accepted unknown variant")
	}
}
