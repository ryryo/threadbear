// Chromium subprocess entry point. The bundler uses the same binary to
// deploy the pinned framework and helper apps before signing.
fn main() {
    if std::env::args_os().nth(1).as_deref() == Some(std::ffi::OsStr::new("--stage-runtime")) {
        if let Err(error) = stage_runtime() {
            eprintln!("threadbear-web-helper: {error}");
            std::process::exit(1);
        }
        return;
    }
    std::process::exit(threadbear_web::helper_main());
}

fn stage_runtime() -> Result<(), String> {
    use std::path::PathBuf;
    use threadbear_core::web_runtime as core;

    let args: Vec<_> = std::env::args_os().skip(2).collect();
    let [archive, bundle, id] = args.as_slice() else {
        return Err("usage: --stage-runtime <archive> <app bundle> <bundle id>".into());
    };
    let runtime = core::this_archive().ok_or("no web runtime for this system")?;
    let bin = std::env::current_exe().map_err(|e| e.to_string())?;
    let bundle = PathBuf::from(bundle);
    let id = id.to_str().ok_or("the bundle identifier must be UTF-8")?;
    core::unpack_for_application(&PathBuf::from(archive), &runtime.pin(), &bundle).map_err(
        |e| match e {
            core::InstallError::Failed(why) => why,
            core::InstallError::Cancelled => "runtime unpacking was cancelled".into(),
        },
    )?;
    core::make_application_helpers(&bundle, &bin, id)
}
