# Medalbot Render SDKs

Public clients for the render API at https://render.medalbot.cc. The render service and native renderer are private. This repository contains only client code, documentation, and release artifacts.

Each client's render method waits for complete image URLs, whether the images are cached or require a new render. Requests use your API key.

## TypeScript

```sh
npm install https://github.com/Flo4604/render-sdks/releases/download/v0.1.1/medalbot-render-0.1.1.tgz
```

Import `RenderClient` from `@medalbot/render`. See the [TypeScript guide](docs/typescript.md).

## Python

```sh
python -m pip install https://github.com/Flo4604/render-sdks/releases/download/v0.1.1/medalbot_render-0.1.1-py3-none-any.whl
```

Import `RenderClient` from `medalbot_render`. See the [Python guide](docs/python.md).

## Go

```sh
go get github.com/Flo4604/render-sdks/go@v0.1.1
```

Import `github.com/Flo4604/render-sdks/go`. See the [Go guide](go/README.md).

## C#

Await `RenderClient.RenderAsync()` from `Medalbot.Render` to get image URLs. The [C# guide](csharp/README.md) includes NuGet and public package installation instructions. The [C# release](https://github.com/Flo4604/render-sdks/releases/tag/csharp/v0.1.0) contains a dependency-free .NET 8 package.

All packages are available without access to the private service repository. The release includes SHA-256 checksums. npm and PyPI registry names are not required for these installation commands.
