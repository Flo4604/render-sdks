using System.Net;
using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Text.RegularExpressions;

namespace Medalbot.Render;

public sealed class RenderClient : IDisposable
{
    private readonly HttpClient http;
    private readonly TimeSpan timeout;
    private readonly string apiKey;
    private static readonly Regex IdPattern = new("^rnd_(?:[0-7][0-9A-HJKMNP-TV-Z]{25}|[a-f0-9]{32})$", RegexOptions.CultureInvariant);
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web)
    {
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
        Converters = { new JsonStringEnumConverter(JsonNamingPolicy.CamelCase, allowIntegerValues: false) },
    };

    // A supplied handler remains owned by the caller and must disable redirects.
    public RenderClient(string apiKey, RenderClientOptions? options = null, HttpMessageHandler? handler = null)
    {
        if (string.IsNullOrWhiteSpace(apiKey) || apiKey.Contains('\r') || apiKey.Contains('\n'))
            throw new ArgumentException("An API key without newlines is required", nameof(apiKey));
        options ??= new();
        if (!options.BaseUrl.IsAbsoluteUri || options.BaseUrl.Scheme is not ("https" or "http") ||
            options.BaseUrl.UserInfo.Length > 0 || options.BaseUrl.Query.Length > 0 || options.BaseUrl.Fragment.Length > 0)
            throw new ArgumentException("BaseUrl must be HTTP(S) without credentials, query, or fragment", nameof(options));
        ValidateTimeout(options.Timeout);
        this.apiKey = apiKey;
        timeout = options.Timeout;
        http = new HttpClient(handler ?? new HttpClientHandler { AllowAutoRedirect = false }, disposeHandler: handler is null)
        {
            BaseAddress = new Uri(options.BaseUrl.AbsoluteUri.TrimEnd('/') + "/"),
            Timeout = System.Threading.Timeout.InfiniteTimeSpan,
        };
    }

    public Task<RenderImages> RenderAsync(RenderRequest request, RenderOptions? options = null,
        CancellationToken cancellationToken = default) => Operate(async operation =>
    {
        var state = await Submit(request, options, wait: true, operation).ConfigureAwait(false);
        var images = await Poll(state, operation).ConfigureAwait(false);
        foreach (var view in request.Views ?? [RenderView.Preview, RenderView.Front, RenderView.Back])
            if (images[view] is null) throw InvalidResponse($"Completed render is missing {view}");
        return images;
    }, options, cancellationToken);

    public Task<RenderState> CreateAsync(RenderRequest request, RenderOptions? options = null,
        CancellationToken cancellationToken = default) => Operate(operation => Submit(request, options, wait: false, operation), options, cancellationToken);

    public Task<RenderState> GetAsync(string renderId, CancellationToken cancellationToken = default) =>
        Operate(operation => Get(renderId, operation), null, cancellationToken, renderId);

    // Use options.Links to send Prefer: links; options.Timeout bounds the call.
    public Task<RenderState> GetAsync(string renderId, RenderOptions? options, CancellationToken cancellationToken = default) =>
        Operate(operation => Get(renderId, operation, options?.Links ?? false), options, cancellationToken, renderId);

    public Task<RenderImages> WaitAsync(string renderId, RenderOptions? options = null,
        CancellationToken cancellationToken = default) => Operate(async operation =>
    {
        var state = await Get(renderId, operation).ConfigureAwait(false);
        return await Poll(state, operation).ConfigureAwait(false);
    }, options, cancellationToken, renderId);

    private sealed class Operation(CancellationToken token)
    {
        public CancellationToken Token { get; } = token;
        public string? RenderId { get; set; }
        public string? RequestId { get; set; }
        public string? Key { get; set; }
    }

    private async Task<T> Operate<T>(Func<Operation, Task<T>> action, RenderOptions? options,
        CancellationToken caller, string? renderId = null)
    {
        var budget = options?.Timeout ?? timeout;
        ValidateTimeout(budget);
        using var deadline = CancellationTokenSource.CreateLinkedTokenSource(caller);
        deadline.CancelAfter(budget);
        var operation = new Operation(deadline.Token) { RenderId = renderId };
        try
        {
            deadline.Token.ThrowIfCancellationRequested();
            return await action(operation).ConfigureAwait(false);
        }
        catch (OperationCanceledException error) when (caller.IsCancellationRequested)
        {
            throw new RenderCanceledException(operation.RenderId, operation.RequestId, operation.Key, error, caller);
        }
        catch (OperationCanceledException error)
        {
            throw Enrich(new RenderException("wait_timeout", "Wait timed out; resume with WaitAsync or retry with the same idempotency key", inner: error), operation);
        }
        catch (RenderException error) { throw Enrich(error, operation); }
    }

    private static RenderException Enrich(RenderException error, Operation operation)
    {
        error.RenderId ??= operation.RenderId;
        error.RequestId ??= operation.RequestId;
        error.IdempotencyKey ??= operation.Key;
        return error;
    }

    private static void ValidateTimeout(TimeSpan value)
    {
        if (value <= TimeSpan.Zero || value.TotalMilliseconds > uint.MaxValue - 1)
            throw new ArgumentOutOfRangeException(nameof(value), "Timeout must be positive and no more than 49 days");
    }

    private Task<RenderState> Submit(RenderRequest request, RenderOptions? options, bool wait, Operation operation)
    {
        ArgumentNullException.ThrowIfNull(request);
        if (string.IsNullOrWhiteSpace(request.InspectUrl) || request.InspectUrl.Length > 32768)
            throw new ArgumentException("InspectUrl must contain 1 to 32768 characters", nameof(request));
        if (request.Format is { } format && !Enum.IsDefined(format))
            throw new ArgumentException("Unknown image format", nameof(request));
        if (request.Appearance is { } appearance && !Enum.IsDefined(appearance))
        {
            throw new ArgumentException("Unknown render appearance", nameof(request));
        }

        if (request.StatTrak is < 0 or > 999999)
            throw new ArgumentOutOfRangeException(nameof(request), "StatTrak must be between 0 and 999999");
        if (request.Views is { } views && (views.Count is < 1 or > 3 || views.Any(view => !Enum.IsDefined(view)) || views.Distinct().Count() != views.Count))
            throw new ArgumentException("Views must contain unique preview, front, or back values", nameof(request));
        operation.Key = options?.IdempotencyKey ?? Guid.NewGuid().ToString("N");
        if (operation.Key.Length is < 1 or > 128 || operation.Key.Any(character => character is < '!' or > '~'))
            throw new ArgumentException("IdempotencyKey must contain 1 to 128 printable ASCII characters without spaces", nameof(options));
        return Request(HttpMethod.Post, "v1/renders", JsonSerializer.Serialize(request, Json), Prefer(wait, options?.Links ?? false), operation);
    }

    private static string? Prefer(bool wait, bool links) => (wait, links) switch
    {
        (true, true) => "wait=10, links",
        (true, false) => "wait=10",
        (false, true) => "links",
        _ => null,
    };

    private async Task<RenderState> Get(string id, Operation operation, bool links = false)
    {
        if (!IdPattern.IsMatch(id)) throw new ArgumentException("Invalid render ID", nameof(id));
        var state = await Request(HttpMethod.Get, $"v1/renders/{id}", null, Prefer(false, links), operation).ConfigureAwait(false);
        if (state.Id != id) throw InvalidResponse("Response render ID does not match the request");
        return state;
    }

    private async Task<RenderImages> Poll(RenderState state, Operation operation)
    {
        var delay = TimeSpan.FromMilliseconds(500);
        while (true)
        {
            operation.Token.ThrowIfCancellationRequested();
            if (state.Status == RenderStatus.Completed) return state.Images!;
            if (state.Status == RenderStatus.Failed) throw new RenderException(state.Error!.Code, state.Error.Detail);
            await Task.Delay(delay, operation.Token).ConfigureAwait(false);
            state = await Get(state.Id, operation).ConfigureAwait(false);
            delay = TimeSpan.FromMilliseconds(Math.Min(2000, delay.TotalMilliseconds * 1.5));
        }
    }

    private async Task<RenderState> Request(HttpMethod method, string path, string? body, string? prefer, Operation operation)
    {
        for (var attempt = 0; ; attempt++)
        {
            operation.Token.ThrowIfCancellationRequested();
            using var request = new HttpRequestMessage(method, path);
            request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", apiKey);
            request.Headers.Accept.Add(new("application/json"));
            if (body is not null)
            {
                request.Content = new StringContent(body, Encoding.UTF8, "application/json");
                request.Headers.Add("Idempotency-Key", operation.Key);
            }
            if (prefer is not null) request.Headers.TryAddWithoutValidation("Prefer", prefer);
            try
            {
                using var response = await http.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, operation.Token).ConfigureAwait(false);
                if (response.Headers.TryGetValues("X-Request-Id", out var values)) operation.RequestId = values.FirstOrDefault();
                if ((int)response.StatusCode is 429 or 502 or 503 or 504 && attempt < 3)
                {
                    await Task.Delay(RetryDelay(attempt, response.Headers.RetryAfter), operation.Token).ConfigureAwait(false);
                    continue;
                }
                var payload = await ReadBody(response, operation.Token).ConfigureAwait(false);
                var state = Parse(response.StatusCode, payload);
                operation.RenderId ??= state.Id;
                operation.RequestId = state.RequestId;
                return state;
            }
            catch (HttpRequestException error)
            {
                if (attempt == 3) throw new RenderException("network_error", "Could not complete the HTTP request", inner: error);
                await Task.Delay(RetryDelay(attempt, null), operation.Token).ConfigureAwait(false);
            }
            catch (IOException error)
            {
                if (attempt == 3) throw new RenderException("network_error", "Could not read the HTTP response", inner: error);
                await Task.Delay(RetryDelay(attempt, null), operation.Token).ConfigureAwait(false);
            }
        }
    }

    private static TimeSpan RetryDelay(int attempt, RetryConditionHeaderValue? retryAfter)
    {
        var milliseconds = (200 << attempt) + Random.Shared.Next(100);
        var minimum = retryAfter?.Delta ?? (retryAfter?.Date - DateTimeOffset.UtcNow) ?? TimeSpan.Zero;
        return TimeSpan.FromMilliseconds(Math.Min(uint.MaxValue - 1, Math.Max(milliseconds, minimum.TotalMilliseconds)));
    }

    private static async Task<byte[]> ReadBody(HttpResponseMessage response, CancellationToken token)
    {
        const int maxBytes = 1024 * 1024;
        await using var stream = await response.Content.ReadAsStreamAsync(token).ConfigureAwait(false);
        using var output = new MemoryStream();
        var buffer = new byte[8192];
        while (true)
        {
            var count = await stream.ReadAsync(buffer, token).ConfigureAwait(false);
            if (count == 0) return output.ToArray();
            if (output.Length + count > maxBytes) throw InvalidResponse("Response exceeds 1 MiB");
            output.Write(buffer, 0, count);
        }
    }

    private static RenderState Parse(HttpStatusCode status, byte[] payload)
    {
        var success = (int)status is >= 200 and < 300;
        string? requestId = null;
        try
        {
            using var document = JsonDocument.Parse(payload);
            var root = document.RootElement;
            requestId = root.TryGetProperty("meta", out var meta) && meta.TryGetProperty("requestId", out var value) ? value.GetString() : null;
            if (!success)
            {
                var code = "http_error";
                var detail = $"HTTP {(int)status} {status}";
                if (root.TryGetProperty("error", out var error))
                {
                    if (error.TryGetProperty("code", out value)) code = value.GetString() ?? code;
                    if (error.TryGetProperty("detail", out value) || error.TryGetProperty("message", out value)) detail = value.GetString() ?? detail;
                }
                throw new RenderException(code, detail, (int)status) { RequestId = requestId };
            }
            if (string.IsNullOrWhiteSpace(requestId)) throw InvalidResponse("Response has no request ID");
            var data = root.GetProperty("data");
            var id = data.GetProperty("id").GetString();
            if (id is null || !IdPattern.IsMatch(id)) throw InvalidResponse("Response has an invalid render ID");
            RenderImages? images = null;
            RenderImages? links = null;
            RenderStatus state;
            RenderFailure? failure = null;
            if (data.TryGetProperty("images", out var imageMap))
            {
                images = ParseViews(imageMap, "image");
                if (images is { Preview: null, Front: null, Back: null }) throw InvalidResponse("Completed render has no images");
                if (data.TryGetProperty("status", out _)) throw InvalidResponse("Completed render must omit status");
                state = RenderStatus.Completed;
            }
            else
            {
                state = data.GetProperty("status").GetString() switch
                {
                    "queued" => RenderStatus.Queued,
                    "rendering" => RenderStatus.Rendering,
                    "processing" => RenderStatus.Processing,
                    "failed" => RenderStatus.Failed,
                    _ => throw InvalidResponse("Response has an invalid render status"),
                };
                if (state == RenderStatus.Failed)
                {
                    var error = data.GetProperty("error");
                    var code = error.GetProperty("code").GetString();
                    var detail = error.GetProperty("detail").GetString();
                    if (string.IsNullOrWhiteSpace(code) || detail is null) throw InvalidResponse("Failed render has no error");
                    failure = new(code, detail);
                }
            }
            if (state != RenderStatus.Failed && data.TryGetProperty("links", out var linkMap))
                links = ParseViews(linkMap, "link");
            return new(id, state, images, failure, requestId) { Links = links };
        }
        catch (RenderException error)
        {
            error.RequestId ??= requestId;
            throw;
        }
        catch (Exception error) when (error is JsonException or InvalidOperationException or KeyNotFoundException)
        {
            throw new RenderException(success ? "invalid_response" : "http_error",
                success ? "Response is not a valid render JSON object" : $"HTTP {(int)status} {status}",
                success ? null : (int)status, error)
            { RequestId = requestId };
        }
    }

    private static RenderImages ParseViews(JsonElement map, string noun)
    {
        string? preview = null, front = null, back = null;
        foreach (var entry in map.EnumerateObject())
        {
            var url = entry.Value.GetString();
            if (!Uri.TryCreate(url, UriKind.Absolute, out var uri) || uri.Scheme is not ("https" or "http"))
                throw InvalidResponse($"Response has an invalid {noun} URL");
            switch (entry.Name)
            {
                case "preview": preview = url; break;
                case "front": front = url; break;
                case "back": back = url; break;
                default: throw InvalidResponse($"Response has an unknown {noun} view");
            }
        }
        return new(preview, front, back);
    }

    private static RenderException InvalidResponse(string detail) => new("invalid_response", detail);
    public void Dispose() => http.Dispose();
}
