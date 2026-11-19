# Bimage

Bimage is an independent multi-tenant image workbench. The interface is Chinese-first, for creators who iterate on prompts, reference images and saved results. Existing custom site names and icons are retained from the server.

## Product boundaries
- Task-first workbench, not an Agent, canvas product or marketing landing page.
- OpenAI-compatible providers and API keys are managed through the backend; secrets are never read back into the browser.
- Tenant-scoped persisted forms, provider catalogs/defaults, image tasks and originals. Explicit submission is the only generation action; retry and repair only refill drafts.
- Reference and vision workflows share a maximum of 16 images. Uploads support PNG/JPEG/WebP and reject files over 8 MiB. Vision aggregate limits are enforced by the API.
- Administrators manage site branding, ordinary member keys and deliberate administrator key rotation; never a second administrator.
- Actual output dimensions come from backend byte inspection, never request estimates. Unknown dimensions remain unknown.
- Default sizing is automatic, omitting upstream size, ratio and resolution fields. Legacy manual forms remain restorable.

## Brand assets
Default logo: `frontend/public/Bimage.png`, an RGBA PNG. Custom icons can be uploaded in site settings; the independent 80×80 preview belongs beside the upload button near the site-icon label, not beside the save action.

## Verification boundary
Frontend browser tests intercept all /api requests with explicit synthetic fixtures. They do not exercise paid image services or production data. Backend correctness is independently validated by the backend owner.
