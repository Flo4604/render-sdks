using System.Diagnostics;
using System.Globalization;
using System.Net.Http.Headers;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace Medalbot.Render;

// Identification headers and call timings. Every request names the SDK and carries a W3C
// traceparent whose trace id is fixed for one call. Unless RenderClientOptions.Telemetry is
// false, each finished call becomes one sdk_call event; events go to POST /v1/telemetry/sdk
// in batches, and a failed send is dropped. Nothing here throws into the caller or delays a
// render.
internal static class Identity
{
    public static readonly string Version = FormatVersion(typeof(RenderClient).Assembly.GetName().Version);
    public static readonly string Runtime = $"dotnet/{Environment.Version}";
    public static readonly string Os =
        OperatingSystem.IsWindows() ? "windows" :
        OperatingSystem.IsMacOS() ? "darwin" :
        OperatingSystem.IsLinux() ? "linux" :
        OperatingSystem.IsFreeBSD() ? "freebsd" : "unknown";
    public static readonly string UserAgent = $"medalbot-render-csharp/{Version} ({Runtime}; {Os})";
    public static readonly string SdkHeader = $"csharp/{Version}";

    private static string FormatVersion(Version? version) =>
        version is null ? "0.0.0" : $"{version.Major}.{version.Minor}.{Math.Max(0, version.Build)}";

    public static string RandomHex(int bytes) => Convert.ToHexString(RandomNumberGenerator.GetBytes(bytes)).ToLowerInvariant();
}

// What one call observed. HTTP time covers each attempt from send to the end of the body; the
// sleeps between polls and between retries are counted apart from it. ServerMs sums the API's
// own Server-Timing over every response, so network and gateway time is HttpMs - ServerMs.
internal sealed class CallTrace(string op, int inflight, int? views)
{
    private static readonly Regex ServerTiming = new(@"(?:^|,)\s*app;dur=([\d.]+)", RegexOptions.CultureInvariant);
    private readonly Stopwatch clock = Stopwatch.StartNew();
    private readonly object gate = new();
    public string TraceId { get; } = Identity.RandomHex(16);
    public double HttpMs, ServerMs, BackoffMs, PollWaitMs;
    public double? TtfbMs;
    public int Requests, Retries, Polls, Status;
    public string? RequestId, ServerTraceId, Cache, RenderId;

    public string Traceparent() => $"00-{TraceId}-{Identity.RandomHex(8)}-01";
    public double Now => clock.Elapsed.TotalMilliseconds;

    public void Headers(HttpResponseMessage response, double started)
    {
        lock (gate)
        {
            TtfbMs ??= Now - started;
            Status = (int)response.StatusCode;
            RequestId ??= First(response.Headers, "X-Request-Id");
            ServerTraceId ??= First(response.Headers, "X-Trace-Id");
            Cache ??= First(response.Headers, "X-Render-Cache");
            var timing = ServerTiming.Match(First(response.Headers, "Server-Timing") ?? "");
            if (timing.Success && double.TryParse(timing.Groups[1].Value, NumberStyles.Float, CultureInfo.InvariantCulture, out var value))
                ServerMs += value;
        }
    }

    public void Attempt(double started)
    {
        lock (gate)
        {
            Requests++;
            HttpMs += Now - started;
        }
    }

    private static string? First(HttpResponseHeaders headers, string name) =>
        headers.TryGetValues(name, out var values) ? values.FirstOrDefault() : null;

    public Dictionary<string, object> Fields(Exception? error)
    {
        lock (gate)
        {
            var fields = new Dictionary<string, object>
            {
                ["op"] = op,
                ["outcome"] = error is null ? "ok" : "error",
                ["total_ms"] = Math.Round(Now),
                ["inflight"] = inflight,
                ["status"] = Status,
                ["trace_id"] = TraceId,
                ["http_ms"] = Math.Round(HttpMs),
                ["server_ms"] = Math.Round(ServerMs),
                ["requests"] = Requests,
                ["retries"] = Retries,
                ["backoff_ms"] = Math.Round(BackoffMs),
                ["polls"] = Polls,
                ["poll_wait_ms"] = Math.Round(PollWaitMs),
            };
            if (error is not null) fields["code"] = ErrorCode(error);
            if (TtfbMs is { } ttfb) fields["ttfb_ms"] = Math.Round(ttfb);
            if (views is { } count) fields["views"] = count;
            if (RequestId is { Length: > 0 }) fields["request_id"] = Truncate(RequestId, 64);
            if (ServerTraceId is { Length: > 0 }) fields["server_trace_id"] = Truncate(ServerTraceId, 64);
            if (Cache is { Length: > 0 }) fields["cache"] = Truncate(Cache, 16);
            if (RenderId is { Length: > 0 }) fields["render_id"] = RenderId;
            return fields;
        }
    }

    private static string Truncate(string value, int length) => value.Length > length ? value[..length] : value;

    private static readonly Regex StableCode = new("^[a-z0-9_]{1,64}$", RegexOptions.CultureInvariant);

    private static string ErrorCode(Exception error)
    {
        if (error is RenderException render)
        {
            var code = render.Code.ToLowerInvariant();
            return StableCode.IsMatch(code) ? code : "other";
        }
        return error switch
        {
            OperationCanceledException => "canceled",
            ArgumentException => "invalid_input",
            _ => "client_error",
        };
    }
}

// Buffers events and sends them in batches with the client's own HttpClient.
internal sealed class TelemetryReporter : IDisposable
{
    // Calls at least this slow, and every failed call, are always reported, so the sample never
    // hides the calls a customer complains about. The rest are reported at the sample rate.
    private const double SlowMs = 3000;
    private const int MaxBatch = 100;
    private const int MaxBuffered = 1000;
    private static readonly TimeSpan FlushAfter = TimeSpan.FromSeconds(10);

    private readonly object gate = new();
    private readonly HttpClient http;
    private readonly string apiKey;
    private readonly double rate;
    private readonly string session = Identity.RandomHex(8);
    private readonly List<object> buffer = [];
    private readonly List<Task> sending = [];
    private readonly Timer timer;
    private bool timerArmed;
    private bool stopped;

    private TelemetryReporter(HttpClient http, string apiKey, double rate)
    {
        this.http = http;
        this.apiKey = apiKey;
        this.rate = rate;
        timer = new Timer(_ => { lock (gate) SendLocked(); });
    }

    // The reporter the options name, or null when telemetry is off. MEDALBOT_TELEMETRY=0 (or
    // false, off) turns it off for every client in the process.
    public static TelemetryReporter? Create(HttpClient http, string apiKey, RenderClientOptions options)
    {
        if (!options.Telemetry) return null;
        var env = Environment.GetEnvironmentVariable("MEDALBOT_TELEMETRY")?.Trim().ToLowerInvariant();
        if (env is "0" or "false" or "off") return null;
        if (!(options.TelemetrySampleRate > 0)) return null;
        return new TelemetryReporter(http, apiKey, Math.Min(1, options.TelemetrySampleRate));
    }

    public void Record(CallTrace call, Exception? error)
    {
        try
        {
            var fields = call.Fields(error);
            var always = error is not null || (double)fields["total_ms"] >= SlowMs;
            lock (gate)
            {
                if (stopped || buffer.Count >= MaxBuffered) return;
                if (!always && Random.Shared.NextDouble() >= rate) return;
                buffer.Add(new
                {
                    name = "sdk_call",
                    t = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
                    sample_rate = always ? 1 : rate,
                    fields,
                });
                if (buffer.Count >= MaxBatch) SendLocked();
                else if (!timerArmed)
                {
                    timerArmed = true;
                    timer.Change(FlushAfter, System.Threading.Timeout.InfiniteTimeSpan);
                }
            }
        }
        catch (Exception)
        {
            // Telemetry never reaches the caller.
        }
    }

    private void SendLocked()
    {
        timerArmed = false;
        timer.Change(System.Threading.Timeout.Infinite, System.Threading.Timeout.Infinite);
        sending.RemoveAll(task => task.IsCompleted);
        while (buffer.Count > 0 && !stopped)
        {
            var events = buffer.Take(MaxBatch).ToArray();
            buffer.RemoveRange(0, events.Length);
            sending.Add(Task.Run(() => Send(events)));
        }
    }

    private async Task Send(object[] events)
    {
        try
        {
            var body = JsonSerializer.Serialize(new
            {
                schema = 1,
                session,
                sdk = new { name = "csharp", version = Identity.Version, runtime = Identity.Runtime, os = Identity.Os },
                events,
            });
            using var request = new HttpRequestMessage(HttpMethod.Post, "v1/telemetry/sdk")
            {
                Content = new StringContent(body, Encoding.UTF8, "application/json"),
            };
            request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", apiKey);
            using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(5));
            using var response = await http.SendAsync(request, timeout.Token).ConfigureAwait(false);
            // No route, or a key the route refuses: stop reporting for this client.
            if ((int)response.StatusCode is 401 or 403 or 404 or 410)
                lock (gate) { stopped = true; buffer.Clear(); }
        }
        catch (Exception)
        {
            // A failed send is dropped.
        }
    }

    public async Task FlushAsync(CancellationToken token)
    {
        Task[] pending;
        lock (gate)
        {
            SendLocked();
            pending = [.. sending];
        }
        try
        {
            await Task.WhenAll(pending).WaitAsync(token).ConfigureAwait(false);
        }
        catch (OperationCanceledException)
        {
            // The caller stopped waiting; the sends continue in the background.
        }
    }

    public void Dispose() => timer.Dispose();
}
