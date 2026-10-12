# Skinicon SDKs

Public clients for the render API at https://render.medalbot.cc. The render service and native renderer are private. This repository contains only client code, documentation, and release artifacts.

Each client's render method waits for complete image URLs, whether the images are cached or require a new render. Requests use your API key.

## TypeScript

```sh
npm install https://github.com/Flo4604/skinicon-sdks/releases/download/v0.1.0/medalbot-skinicon-0.1.0.tgz
```

Import `Skinicon` from `@medalbot/skinicon`. See the [TypeScript guide](docs/typescript.md).

## Python

```sh
python -m pip install https://github.com/Flo4604/skinicon-sdks/releases/download/v0.1.0/skinicon-0.1.0-py3-none-any.whl
```

Import `Skinicon` from `skinicon`. See the [Python guide](docs/python.md).

## Go

```sh
go get github.com/Flo4604/skinicon-sdks/go@v0.1.0
```

Import `github.com/Flo4604/skinicon-sdks/go`. See the [Go guide](go/README.md).

All packages are available without access to the private service repository. The release includes SHA-256 checksums. npm and PyPI registry names are not required for these installation commands.
