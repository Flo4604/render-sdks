package render

import (
	"fmt"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"unicode"
)

type ImageVariant string

const (
	Small ImageVariant = "small"
	Card  ImageVariant = "card"
	Zoom  ImageVariant = "zoom"
)

var originalImage = regexp.MustCompile(`^https?://([^/\s\\?#]+)/v1/([A-Za-z0-9_-]{42}[AEIMQUYcgkosw048])\.(?:webp|png)$`)

// ImageURL builds a public derivative URL without fetching or changing the original.
func ImageURL(original string, variant ImageVariant) (string, error) {
	if variant != Small && variant != Card && variant != Zoom {
		return "", fmt.Errorf("image variant must be small, card, or zoom")
	}
	match := originalImage.FindStringSubmatch(original)
	if match == nil || strings.Contains(match[1], "@") || strings.IndexFunc(original, func(r rune) bool { return unicode.IsSpace(r) || r < 32 || r == 127 }) >= 0 {
		return "", fmt.Errorf("expected an absolute HTTP(S) original image URL with path /v1/<canonical SHA-256>.webp or .png and no credentials, query, or fragment")
	}
	parsed, err := url.Parse(original)
	if err != nil || parsed.Hostname() == "" {
		return "", fmt.Errorf("invalid original image URL")
	}
	if port := parsed.Port(); port != "" {
		n, err := strconv.Atoi(port)
		if err != nil || n < 0 || n > 65535 {
			return "", fmt.Errorf("invalid original image URL port")
		}
	}
	parsed.Path = "/d/v1/" + match[2] + "_" + string(variant) + ".webp"
	return parsed.String(), nil
}
