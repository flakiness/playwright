# Contributing

## Prerequisites

- Node.js 22+
- [pnpm](https://pnpm.io/)

## Getting Started

Clone the repo and install dependencies:

```bash
git clone https://github.com/flakiness/playwright.git
cd playwright
pnpm install
```

## Building

This project uses [Kubik](https://github.com/flakiness/kubik) as its build system. The build script is defined in `build.mts`.

To build:

```bash
./build.mts
```

To watch:

```bash
./build.mts -w
```

This will bundle the source with esbuild and generate TypeScript declarations.

## Releasing

To release a new version:

1. Bump the version:

   ```bash
   # For a stable minor release
   pnpm version minor

   # For an alpha pre-release
   pnpm version preminor --preid=alpha
   ```

2. Push the tag:

   ```bash
   git push --tags
   ```

   CI will handle publishing to npm. Pre-releases are published under @next tag.
