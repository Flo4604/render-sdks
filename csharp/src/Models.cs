namespace Medalbot.Render;

public enum RenderView { Preview, Front, Back }
public enum ImageFormat { Webp, Png }
public enum RenderStatus { Queued, Rendering, Processing, Completed, Failed }

public sealed record RenderRequest
{
    public required string InspectUrl { get; init; }
    public IReadOnlyList<RenderView>? Views { get; init; }
    public ImageFormat? Format { get; init; }
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
public sealed record RenderState(string Id, RenderStatus Status, RenderImages? Images,
    RenderFailure? Error, string RequestId);

public sealed record RenderClientOptions
{
    public Uri BaseUrl { get; init; } = new("https://render.medalbot.cc");
    public TimeSpan Timeout { get; init; } = TimeSpan.FromMinutes(2);
}

public sealed record RenderOptions
{
    public string? IdempotencyKey { get; init; }
    public TimeSpan? Timeout { get; init; }
}

public sealed class RenderException : Exception
{
    public string Code { get; }
    public int? StatusCode { get; }
    public string? RenderId { get; internal set; }
    public string? RequestId { get; internal set; }
    public string? IdempotencyKey { get; internal set; }

    internal RenderException(string code, string detail, int? statusCode = null, Exception? inner = null)
        : base(detail, inner) { Code = code; StatusCode = statusCode; }
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
