using System.Text.RegularExpressions;

namespace Medalbot.Render;

public enum ImageVariant { Small, Card, Zoom }

public static class Media
{
    private static readonly Regex Original = new(@"^https?://(?<authority>[^/\s\x00-\x1f\x7f\\?#]+)/v1/(?<hash>[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048])\.(?:webp|png)\z", RegexOptions.CultureInvariant);

    // This helper creates a URL. It does not download or change the original image.
    public static string ImageUrl(string original, ImageVariant variant)
    {
        var name = variant switch
        {
            ImageVariant.Small => "small",
            ImageVariant.Card => "card",
            ImageVariant.Zoom => "zoom",
            _ => throw new ArgumentOutOfRangeException(nameof(variant), "Image variant must be Small, Card, or Zoom"),
        };
        ArgumentNullException.ThrowIfNull(original);
        var match = Original.Match(original);
        if (!match.Success || match.Groups["authority"].Value.Contains('@') ||
            !Uri.TryCreate(original, UriKind.Absolute, out var uri) || uri.Host.Length == 0)
            throw new ArgumentException("Expected an absolute HTTP(S) original image URL with path /v1/<canonical SHA-256>.webp or .png and no credentials, query, or fragment", nameof(original));
        return $"{uri.GetLeftPart(UriPartial.Authority)}/d/v1/{match.Groups["hash"].Value}_{name}.webp";
    }
}
