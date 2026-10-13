using System.Net;
using System.Net.Sockets;
using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;
using Medalbot.Render;

const string id = "rnd_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const string front = "https://img.medalbot.cc/front.webp";
var request = new RenderRequest { InspectUrl = "steam://inspect", Views = [RenderView.Front] };
var tests = new List<(string, Func<Task>)>();
string Envelope(object data, string requestId = "req_test") => JsonSerializer.Serialize(new { meta = new { requestId }, data });
string Complete() => Envelope(new { id, images = new { front } });
string Queued() => Envelope(new { id, status = "queued" });
HttpResponseMessage Response(string body, HttpStatusCode status = HttpStatusCode.OK) => new(status)
{
    Content = new StringContent(body, Encoding.UTF8, "application/json"),
};
RenderClient Client(MockHandler handler, TimeSpan? timeout = null) => new("test-key", new() { Timeout = timeout ?? TimeSpan.FromSeconds(5) }, handler);
void Equal<T>(T expected, T actual) { if (!EqualityComparer<T>.Default.Equals(expected, actual)) throw new Exception($"Expected {expected}, got {actual}"); }
async Task<T> Throws<T>(Func<Task> action) where T : Exception
{
    try { await action(); } catch (T error) { return error; }
    throw new Exception($"Expected {typeof(T).Name}");
}

tests.Add(("media URL helpers preserve origins and select fixed recipes", () =>
{
    var hash = new string('A', 43);
    foreach (var origin in new[] { "https://img.medalbot.cc", "http://localhost:8080", "https://images.example:8443", "http://[::1]:8080" })
        foreach (var format in new[] { "webp", "png" })
            foreach (var variant in Enum.GetValues<ImageVariant>())
                Equal($"{origin}/d/v1/{hash}_{variant.ToString().ToLowerInvariant()}.webp", Media.ImageUrl($"{origin}/v1/{hash}.{format}", variant));
    return Task.CompletedTask;
}));

tests.Add(("media URL helpers reject arbitrary URLs and noncanonical hashes", async () =>
{
    var hash = new string('A', 43);
    var original = $"https://img.medalbot.cc/v1/{hash}.webp";
    foreach (var value in new[] {
        $"/v1/{hash}.webp", original + "?", original + "?w=20", original + "#", original + "#x",
        original.Replace("https:", "file:"), original.Replace("img.medalbot.cc", "user:pass@img.medalbot.cc"),
        original.Replace("img.medalbot.cc", "@img.medalbot.cc"), original.Replace("img.medalbot.cc", "img.medalbot.cc:65536"),
        original.Replace("/v1/", "/x/../v1/"), original.Replace("/v1/", "/v1%2F"),
        original.Replace(hash, hash[..42] + "B"), original.Replace(hash, hash + "="),
        original.Replace(".webp", ".jpg"), original.Replace(".webp", ".webp.webp"),
        original + "\n", " " + original, original.Replace("img.medalbot.cc", "img.\0medalbot.cc"),
        original.Replace("img.medalbot.cc", "img.\u00a0medalbot.cc"), original.Replace("/v1/", "\\v1/"),
        Media.ImageUrl(original, ImageVariant.Card),
    })
        await Throws<ArgumentException>(() => { Media.ImageUrl(value, ImageVariant.Card); return Task.CompletedTask; });
    await Throws<ArgumentOutOfRangeException>(() => { Media.ImageUrl(original, (ImageVariant)99); return Task.CompletedTask; });
}));

tests.Add(("cached result returns images with the public wire format", async () =>
{
    using var handler = new MockHandler(async (message, _) =>
    {
        Equal(HttpMethod.Post, message.Method);
        Equal("https://render.medalbot.cc/v1/renders", message.RequestUri!.ToString());
        Equal("Bearer test-key", message.Headers.Authorization!.ToString());
        Equal("wait=10", message.Headers.GetValues("Prefer").Single());
        Equal("test-admission", message.Headers.GetValues("Idempotency-Key").Single());
        using var body = JsonDocument.Parse(await message.Content!.ReadAsStringAsync());
        Equal("steam://inspect", body.RootElement.GetProperty("inspectUrl").GetString());
        Equal("front", body.RootElement.GetProperty("views")[0].GetString());
        Equal("png", body.RootElement.GetProperty("format").GetString());
        return Response(Complete());
    });
    using var client = Client(handler);
    var images = await client.RenderAsync(request with { Format = ImageFormat.Png }, new() { IdempotencyKey = "test-admission" });
    Equal(front, images.Front);
    Equal(front, images[RenderView.Front]);
    Equal(null, images.Back);
    Equal(1, handler.Calls);
}
));

tests.Add(("StatTrak serializes explicit zero and omits an unspecified counter", async () =>
{
    foreach (int? count in new int?[] { null, 0, 1337, 999999 })
    {
        using var handler = new MockHandler(async (message, _) =>
        {
            using var body = JsonDocument.Parse(await message.Content!.ReadAsStringAsync());
            Equal(count.HasValue, body.RootElement.TryGetProperty("statTrak", out var value));
            if (count.HasValue) Equal(count.Value, value.GetInt32());
            return Response(Complete());
        });
        using var client = Client(handler);
        Equal(front, (await client.RenderAsync(request with { StatTrak = count })).Front);
    }
}
));

tests.Add(("invalid StatTrak counts fail before HTTP submission", async () =>
{
    using var handler = new MockHandler((_, _) => Task.FromResult(Response(Complete())));
    using var client = Client(handler);
    foreach (var count in new[] { -1, 1000000 })
        await Throws<ArgumentOutOfRangeException>(() => client.RenderAsync(request with { StatTrak = count }));
    Equal(0, handler.Calls);
}
));

tests.Add(("queued work polls until complete", async () =>
{
    var calls = 0;
    using var handler = new MockHandler((message, _) =>
    {
        calls++;
        if (calls == 1) return Task.FromResult(Response(Queued(), HttpStatusCode.Accepted));
        Equal(HttpMethod.Get, message.Method);
        Equal($"/v1/renders/{id}", message.RequestUri!.AbsolutePath);
        return Task.FromResult(Response(Complete()));
    });
    using var client = Client(handler);
    Equal(front, (await client.RenderAsync(request)).Front);
    Equal(2, handler.Calls);
}
));

tests.Add(("Create and Get expose state without implicit polling", async () =>
{
    using var handler = new MockHandler((message, _) =>
    {
        Equal(false, message.Headers.Contains("Prefer"));
        return Task.FromResult(Response(Queued()));
    });
    using var client = Client(handler);
    Equal(RenderStatus.Queued, (await client.CreateAsync(request)).Status);
    var state = await client.GetAsync(id);
    Equal(id, state.Id);
    Equal("req_test", state.RequestId);
    Equal(2, handler.Calls);
}
));

tests.Add(("Wait resumes by render ID", async () =>
{
    using var handler = new MockHandler((message, _) =>
    {
        Equal(HttpMethod.Get, message.Method);
        return Task.FromResult(Response(Complete()));
    });
    using var client = Client(handler);
    Equal(front, (await client.WaitAsync(id)).Front);
}
));

tests.Add(("cancellation retains IDs and sends no cancel request", async () =>
{
    using var cancellation = new CancellationTokenSource();
    using var handler = new MockHandler((_, _) =>
    {
        cancellation.CancelAfter(50);
        return Task.FromResult(Response(Queued()));
    });
    using var client = Client(handler);
    var error = await Throws<RenderCanceledException>(() => client.RenderAsync(request, new() { IdempotencyKey = "resume-key" }, cancellation.Token));
    Equal(id, error.RenderId);
    Equal("req_test", error.RequestId);
    Equal("resume-key", error.IdempotencyKey);
    Equal(cancellation.Token, error.CancellationToken);
    Equal(1, handler.Calls);
}
));

tests.Add(("timeout retains the admitted render ID", async () =>
{
    using var handler = new MockHandler((_, _) => Task.FromResult(Response(Queued())));
    using var client = Client(handler, TimeSpan.FromMilliseconds(60));
    var error = await Throws<RenderException>(() => client.RenderAsync(request));
    Equal("wait_timeout", error.Code);
    Equal(id, error.RenderId);
    Equal("req_test", error.RequestId);
    Equal(32, error.IdempotencyKey!.Length);
    Equal(1, handler.Calls);
}
));

tests.Add(("in-flight timeout cancels HTTP and retains its idempotency key", async () =>
{
    using var handler = new MockHandler(async (_, token) =>
    {
        await Task.Delay(5000, token);
        return Response(Complete());
    });
    using var client = Client(handler, TimeSpan.FromMilliseconds(50));
    var error = await Throws<RenderException>(() => client.RenderAsync(request, new() { IdempotencyKey = "recover-admission" }));
    Equal("wait_timeout", error.Code);
    Equal("recover-admission", error.IdempotencyKey);
    Equal(null, error.RenderId);
}
));

tests.Add(("pre-canceled operation makes no request", async () =>
{
    using var cancellation = new CancellationTokenSource();
    cancellation.Cancel();
    using var handler = new MockHandler((_, _) => throw new Exception("Must not send"));
    using var client = Client(handler);
    await Throws<OperationCanceledException>(() => client.RenderAsync(request, cancellationToken: cancellation.Token));
    Equal(0, handler.Calls);
}
));

foreach (var header in new[] { "120", DateTimeOffset.UtcNow.AddMinutes(2).ToString("R") })
    tests.Add(($"Retry-After {header} is bounded by the operation deadline", async () =>
    {
        using var handler = new MockHandler((_, _) =>
        {
            var response = Response("{}", HttpStatusCode.TooManyRequests);
            response.Headers.TryAddWithoutValidation("Retry-After", header);
            response.Headers.Add("X-Request-Id", "req_rate_limit");
            return Task.FromResult(response);
        });
        using var client = Client(handler, TimeSpan.FromMilliseconds(350));
        var error = await Throws<RenderException>(() => client.RenderAsync(request));
        Equal("wait_timeout", error.Code);
        Equal("req_rate_limit", error.RequestId);
        Equal(1, handler.Calls);
    }
    ));

tests.Add(("transient POST retries retain body and admission key", async () =>
{
    string? key = null, body = null;
    var calls = 0;
    using var handler = new MockHandler(async (message, _) =>
    {
        var nextKey = message.Headers.GetValues("Idempotency-Key").Single();
        var nextBody = await message.Content!.ReadAsStringAsync();
        key ??= nextKey;
        body ??= nextBody;
        Equal(key, nextKey);
        Equal(body, nextBody);
        if (++calls == 1) throw new HttpRequestException("reset");
        if (calls == 2) return Response("{}", HttpStatusCode.ServiceUnavailable);
        return Response(Complete());
    });
    using var client = Client(handler);
    Equal(front, (await client.RenderAsync(request)).Front);
    Equal(3, handler.Calls);
}
));

tests.Add(("API errors retain code, status, and body request ID", async () =>
{
    using var handler = new MockHandler((_, _) => Task.FromResult(Response(
        "{\"meta\":{\"requestId\":\"req_denied\"},\"error\":{\"code\":\"forbidden\",\"message\":\"Permission required\"}}", HttpStatusCode.Forbidden)));
    using var client = Client(handler);
    var error = await Throws<RenderException>(() => client.RenderAsync(request));
    Equal("forbidden", error.Code);
    Equal("Permission required", error.Message);
    Equal(403, error.StatusCode);
    Equal("req_denied", error.RequestId);
    Equal(1, handler.Calls);
}
));

tests.Add(("failed render retains render and request IDs", async () =>
{
    using var handler = new MockHandler((_, _) => Task.FromResult(Response(Envelope(new { id, status = "failed", error = new { code = "render_failed", detail = "Unavailable item" } }))));
    using var client = Client(handler);
    var error = await Throws<RenderException>(() => client.RenderAsync(request));
    Equal("render_failed", error.Code);
    Equal(id, error.RenderId);
    Equal("req_test", error.RequestId);
}
));

foreach (var bad in new[]
{
    "not json", "{}", Envelope(new { id, images = new { } }),
    Envelope(new { id, images = new { front = "file:///secret" } }),
    Envelope(new { id, status = "surprise" }),
    Envelope(new { id, images = new { unknown = front } }),
    Envelope(new { id = "invalid", images = new { front } }),
    Envelope(new { id, images = new { back = front } }),
    new string('x', 1024 * 1024 + 1),
})
    tests.Add(($"reject invalid protocol response ({bad.Length} bytes)", async () =>
    {
        using var handler = new MockHandler((_, _) => Task.FromResult(Response(bad)));
        using var client = Client(handler);
        Equal("invalid_response", (await Throws<RenderException>(() => client.RenderAsync(request))).Code);
    }
    ));

tests.Add(("Get rejects a different render ID", async () =>
{
    using var handler = new MockHandler((_, _) => Task.FromResult(Response(Complete())));
    using var client = Client(handler);
    Equal("invalid_response", (await Throws<RenderException>(() => client.GetAsync("rnd_01ARZ3NDEKTSV4RRFFQ69G5FAW"))).Code);
}
));

tests.Add(("invalid inputs are rejected before HTTP", async () =>
{
    using var handler = new MockHandler((_, _) => throw new Exception("Must not send"));
    using var client = Client(handler);
    await Throws<ArgumentException>(() => client.RenderAsync(request with { Views = [RenderView.Front, RenderView.Front] }));
    await Throws<ArgumentException>(() => client.RenderAsync(request with { Format = (ImageFormat)99 }));
    await Throws<ArgumentException>(() => client.RenderAsync(request, new() { IdempotencyKey = "bad\nkey" }));
    await Throws<ArgumentException>(() => client.GetAsync("../other"));
    Equal(0, handler.Calls);
}
));

tests.Add(("default transport rejects redirects instead of forwarding the API key", async () =>
{
    using var listener = new TcpListener(IPAddress.Loopback, 0);
    listener.Start();
    var port = ((IPEndPoint)listener.LocalEndpoint).Port;
    using var stop = new CancellationTokenSource(TimeSpan.FromSeconds(5));
    var connections = 0;
    var server = Task.Run(async () =>
    {
        try
        {
            while (!stop.IsCancellationRequested)
            {
                using var connection = await listener.AcceptTcpClientAsync(stop.Token);
                Interlocked.Increment(ref connections);
                await using var stream = connection.GetStream();
                var buffer = new byte[8192];
                await stream.ReadAsync(buffer, stop.Token);
                var reply = Encoding.ASCII.GetBytes($"HTTP/1.1 302 Found\r\nLocation: http://127.0.0.1:{port}/leaked\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
                await stream.WriteAsync(reply, stop.Token);
            }
        }
        catch (OperationCanceledException) { }
    });
    using var client = new RenderClient("test-key", new() { BaseUrl = new($"http://127.0.0.1:{port}") });
    try
    {
        var error = await Throws<RenderException>(() => client.RenderAsync(request));
        Equal(302, error.StatusCode);
        Equal(1, connections);
    }
    finally { stop.Cancel(); await server; }
}
));

var failures = 0;
foreach (var (name, run) in tests)
{
    try { await run(); Console.WriteLine($"PASS {name}"); }
    catch (Exception error) { failures++; Console.Error.WriteLine($"FAIL {name}: {error}"); }
}
Console.WriteLine($"{tests.Count - failures}/{tests.Count} protocol tests passed");
return failures == 0 ? 0 : 1;

sealed class MockHandler(Func<HttpRequestMessage, CancellationToken, Task<HttpResponseMessage>> send) : HttpMessageHandler
{
    public int Calls { get; private set; }
    protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken token)
    { Calls++; return send(request, token); }
}
