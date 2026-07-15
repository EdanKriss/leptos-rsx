# Development

## Prerequisites

- **VS Code**

- **Node.js**
  - Any current LTS version

- **rust-analyzer (extension)**
  - The purpose of `leptos-rsx` is to fix `rust-analyzer` IDE behavior, it is meaningless
    without it

- **Dependencies:**
```sh
npm install
```

## Testing the extension

Press **F5** (or click run button in "Run and Debug" tab). This runs `npm run build`
as a preLaunch task, then opens a second VS Code window (the Extension Development
Host) with the extension loaded against `test/fixtures/theme_switch.rs`.

The window that opens will then run `rust-analyzer`. This gives you an opportunity
to see the full lifecycle behavior of the addon: the decorations fallback
highlighting should show immediately. Hovers, intellisense, and theme-aware
semantic highlighting should show after `rust-analyzer` completes analysis.

### Test fixtures

Fixture files provide example `view!` usage cases to test the extension against.

`test/fixtures/` is a small `leptos` crate. The extension only does its job after
rust-analyzer expands `view!` and emits its tokens, so rust-analyzer needs a real
workspace to load.

To add a fixture:
- Add `test/fixtures/foo.rs`
  - Files must be at the root of `test/fixtures/`, not nested.
- Add `#[path = "../foo.rs"] mod foo;` to `test/fixtures/src/lib.rs`.
- Regenerate grammar snapshots:
```sh
npm run update-grammar-snapshot
```

To edit a fixture:
- Edit `test/fixtures/foo.rs`
- Regenerate grammar snapshots:
```sh
npm run update-grammar-snapshot
```

## Grammar

The grammar files are stored in `syntaxes/`. These define syntax tokenization.

There is also a test-only grammar at `test/rust.tmLanguage.json`. This a vendored
copy of the VS Code Rust language grammar for tests. See that file for the repo link.

If these files are ever updated, you must regenerate the grammar snapshots:
```sh
npm run update-grammar-snapshot
```

These snapshots are used as a tripwire to catch any unexpected changes in grammar
output against the test fixtures. They are stored next to their respective test fixture 
files in `test/fixtures/*.rs.snap`. They are tested with `npm run test:grammar`.

## Release Build

Currently the release process is manual.

1. Run source tests:
```sh
npm run test
```

2. Bump version in `package.json`

3. Build the `.vsix` file:
```sh
npm run package
```

4. Install the extension locally for final testing:
```sh
code --install-extension leptos-rsx-html-<version>.vsix
```

5. Commit and push changes to git source control.

6. Upload file to marketplace.
    - Currently the process is manual through the portal. TODO: explore automation.
