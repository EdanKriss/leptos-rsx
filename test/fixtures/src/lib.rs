// Aggregates the highlighting fixtures into one crate so rust-analyzer analyzes
// them with `leptos` resolved. Each fixture stays a top-level `.rs` file at the
// fixtures root (for the grammar-snapshot glob and the F5 launch path) and is
// pulled in here via `#[path]`. Add a line per new fixture.
#[path = "../theme_switch.rs"]
mod theme_switch;
