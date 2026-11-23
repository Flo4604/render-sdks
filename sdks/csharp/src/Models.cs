using System.Text.Json;
using System.Text.Json.Serialization;

namespace Medalbot.Render;

public enum RenderView { Preview, Front, Back }
public enum ImageFormat { Webp, Png }
public enum RenderAppearance { Default, Pattern }
public enum RenderStatus { Queued, Rendering, Processing, Completed, Failed }

public sealed record RenderRequest
{
    public required string InspectUrl { get; init; }
    public IReadOnlyList<RenderView>? Views { get; init; }
    public ImageFormat? Format { get; init; }
    public RenderAppearance? Appearance { get; init; }
    public int? StatTrak { get; init; }
    // How long the API keeps the images. Null uses the API key's default, which keeps them forever
    // unless the key sets one.
    [JsonPropertyName("retentionSeconds")]
    [JsonConverter(typeof(RenderRetentionConverter))]
    public RenderRetention? Retention { get; init; }
}

public sealed record RenderRetention
{
    // Whole seconds from one hour to 30 days; null keeps the images forever.
    public TimeSpan? Duration { get; }

    private RenderRetention(TimeSpan? duration) { Duration = duration; }

    // Keeps the images forever, even when the API key has a default retention.
    public static RenderRetention Forever { get; } = new((TimeSpan?)null);

    public static RenderRetention For(TimeSpan duration) => new(duration);

    internal bool IsValid => Duration is not { } duration ||
        (duration.Ticks % TimeSpan.TicksPerSecond == 0 && duration >= TimeSpan.FromHours(1) && duration <= TimeSpan.FromDays(30));
}

internal sealed class RenderRetentionConverter : JsonConverter<RenderRetention>
{
    public override RenderRetention Read(ref Utf8JsonReader reader, Type typeToConvert, JsonSerializerOptions options) =>
        throw new NotSupportedException();

    public override void Write(Utf8JsonWriter writer, RenderRetention value, JsonSerializerOptions options)
    {
        if (value.Duration is { } duration)
        {
            writer.WriteNumberValue((long)duration.TotalSeconds);
            return;
        }
        writer.WriteNullValue();
    }
}

public sealed record RenderImages(string? Preview, string? Front, string? Back)
{
    public string? this[RenderView view] => view switch
    {
        RenderView.Preview => Preview,
        RenderView.Front => Front,
        RenderView.Back => Back,
        _ => throw new ArgumentOutOfRangeException(nameof(view)),
    };
}

public sealed record RenderFailure(string Code, string Detail);
// The parser reads the fields below and ignores response fields this version does not know.
public sealed record RenderState(string Id, RenderStatus Status, RenderImages? Images,
    RenderFailure? Error, string RequestId)
{
    // One URL per requested view, final at admission. A finished view's link equals its image URL;
    // a pending view's link is served by the media edge once the image exists. Present on pending and
    // completed states when the request sets RenderOptions.Links, or by default once the API enables
    // links. Completion still depends on Images.
    public RenderImages? Links { get; init; }
    // When the API stops keeping the images. Null for a render kept forever, and when links are off.
    public DateTimeOffset? RetainUntil { get; init; }
}

public sealed record RenderClientOptions
{
    public Uri BaseUrl { get; init; } = new("https://render.medalbot.cc");
    public TimeSpan Timeout { get; init; } = TimeSpan.FromMinutes(2);
    // Call timings sent to the API. False turns them off; MEDALBOT_TELEMETRY=0 does the same
    // for every client in the process.
    public bool Telemetry { get; init; } = true;
    // The share of fast, successful calls reported. Failed calls and calls of three seconds or
    // more are always reported.
    public double TelemetrySampleRate { get; init; } = 0.25;
}

public sealed record RenderOptions
{
    public string? IdempotencyKey { get; init; }
    public TimeSpan? Timeout { get; init; }
    // Sends Prefer: links so the returned state carries Links. It composes with the wait preference
    // (Prefer: wait=10, links). Once the API returns links by default, it changes nothing.
    public bool Links { get; init; }
}

public class RenderException : Exception
{
    public string Code { get; }
    public int? StatusCode { get; }
    public string? RenderId { get; internal set; }
    public string? RequestId { get; internal set; }
    public string? IdempotencyKey { get; internal set; }

    internal RenderException(string code, string detail, int? statusCode = null, Exception? inner = null)
        : base(detail, inner) { Code = code; StatusCode = statusCode; }

    internal static RenderException For(string code, string detail, int? statusCode = null) =>
        code == RenderExpiredException.ErrorCode ? new RenderExpiredException(detail, statusCode) : new RenderException(code, detail, statusCode);
}

// The render's retention ended or it was deleted, so the API no longer has its images. Retrying never
// succeeds; submit again with a new idempotency key to render the item again.
public sealed class RenderExpiredException : RenderException
{
    public const string ErrorCode = "render_expired";

    internal RenderExpiredException(string detail, int? statusCode = null) : base(ErrorCode, detail, statusCode) { }
}

// Preserve normal .NET cancellation handling while retaining resumable identifiers.
public sealed class RenderCanceledException : OperationCanceledException
{
    public string? RenderId { get; }
    public string? RequestId { get; }
    public string? IdempotencyKey { get; }

    internal RenderCanceledException(string? renderId, string? requestId, string? key,
        OperationCanceledException inner, CancellationToken token)
        : base("Caller stopped waiting; shared rendering continues", inner, token)
    { RenderId = renderId; RequestId = requestId; IdempotencyKey = key; }
}
