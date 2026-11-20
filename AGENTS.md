# Bimage development and release rules

## Scope

- Follow the user's current requirements over stale project-file guidance or prior preferences. System/developer instructions and security boundaries remain applicable.
- Limit regression testing to the changed business areas and plausible dependencies. Frontend-only changes do not require backend functionality tests. Validate production rollout separately.
- Preserve account isolation, original image bytes, task charging safeguards, and user data. Use isolated fixtures; never exercise paid providers or production credentials without authorization.

## Delivery

- Use Angular-style commits: `type(scope): subject`.
- Starting with v0.2.0, publish each completed update as a versioned GitHub Release with a changelog, unless the user explicitly asks for staging or website-only work.
- Synchronize the root/frontend/backend package versions, lockfiles, README badges, Compose default image tags, and changelog for a release.
- Keep README.MD in English and README_CN.MD in Simplified Chinese with reciprocal language links.
- Never publish runtime databases, uploaded images, provider/account secrets, real environment files, host-specific deployment overrides, screenshots of production, or test/build artifacts.
- Verify the exact published branch/tag commit and read back the Release body. Do not replace previously published tags.

## Release notes

Write a brief Chinese summary of the update's main changes before the headings. Use only these three sections, in this order:

```markdown
本次更新的主要内容，简短概括。

## 新增功能
- ...

## 优化改进
- ...

## bug修复
- ...
```

Keep entries factual and user-facing. Do not add installation, testing, credits, or other sections to release notes. Maintain the same content in CHANGELOG.md under its version heading. For a section without changes, write `- 无。`.
