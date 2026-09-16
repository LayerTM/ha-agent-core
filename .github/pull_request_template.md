## Summary

<!-- What does this change and why? -->

## Related issue

<!-- e.g. #123 -->

## Checklist

- [ ] `npm test` passes
- [ ] `npm run lint` (eslint) and `npm run typecheck` (tsc --checkJs) pass
- [ ] In `app/`: `npm test`, `npm run test:alerts`, `npm run test:config`, `npm run lint`, `npm run typecheck` pass
- [ ] `python .github/scripts/secret_scan.py .` and `python .github/scripts/hygiene_scan.py .` are clean
- [ ] `CHANGELOG.md` updated if behaviour changed
- [ ] `README.md` updated if the archive, lock or verifier contract changed
