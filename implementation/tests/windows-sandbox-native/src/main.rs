#[cfg(windows)]
mod dns_probe;
#[cfg(any(windows, test))]
mod environment;
#[cfg(windows)]
mod integrity;
#[cfg(windows)]
mod probe;
#[cfg(any(windows, test))]
mod progress;
#[cfg(windows)]
mod socket_probe;
#[cfg(windows)]
mod wfp;
#[cfg(windows)]
mod wfp_events;

fn main() {
    #[cfg(windows)]
    probe::main();
    #[cfg(not(windows))]
    panic!("This diagnostic requires native Windows; no simulated pass.");
}
