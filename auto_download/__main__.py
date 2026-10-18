def main() -> None:
    try:
        import tkinter  # noqa: F401
    except ModuleNotFoundError:
        import sys

        print(
            "This Python cannot open the Auto Download window.\n"
            "It is missing tkinter.\n"
            f"Using: {sys.executable}\n"
            "\n"
            "Easiest fix: use the launcher from the repo folder.\n"
            "\n"
            "Windows:\n"
            "  auto_download\\run.bat\n"
            "\n"
            "macOS or Linux:\n"
            "  sh auto_download/run.sh\n"
            "\n"
            "The launcher looks for a full Python install, or offers to install one.\n"
            "On Linux you may also need the python3 tk package from your package manager.",
            file=sys.stderr,
        )
        raise SystemExit(1) from None

    from .gui import run_app

    run_app()


if __name__ == "__main__":
    main()
