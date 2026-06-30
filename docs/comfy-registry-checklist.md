# Comfy Registry Prep Checklist

Registry docs:

- https://docs.comfy.org/registry/overview
- https://docs.comfy.org/registry/publishing
- https://docs.comfy.org/registry/specifications
- https://docs.comfy.org/registry/standards

Current repo prep:

- [x] Public GitHub repository
- [x] README with screenshots and install instructions
- [x] MIT license
- [x] `pyproject.toml` metadata
- [x] `.comfyignore`
- [x] No runtime dependency installation
- [x] No obvious `eval`, `exec`, `subprocess`, or shell command usage
- [x] Banner and icon assets in `docs/images`

Before publishing:

- [ ] Confirm `PublisherId` in `pyproject.toml` matches the Comfy Registry publisher account.
- [ ] Confirm the version number in `pyproject.toml`.
- [ ] Push README, license, metadata, and image assets to GitHub.
- [ ] Create a GitHub release if desired.
- [ ] Publish through the Comfy Registry CLI/workflow.
