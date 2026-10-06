//! X7 `undertone --diagnose`: prints what Undertone sees, for bug reports.

/// True when the process was started with `--diagnose`.
pub fn requested() -> bool {
    std::env::args().skip(1).any(|arg| arg == "--diagnose")
}

/// Prints the report and returns the process exit code.
pub fn run() -> i32 {
    println!("Undertone {} diagnostics", env!("CARGO_PKG_VERSION"));
    0
}
