# Security

Never commit Plaid credentials, Actual passwords, access tokens, Link tokens,
exported configuration, budget data, or transaction data.

Use `.env.example` only as a template. Store real values in an untracked `.env`
file or a container secret manager. The bridge stores Plaid access tokens in
its configured persistent volume; do not publish or back up that volume to a
public location.

If a credential is accidentally committed, revoke or rotate it immediately.
Deleting it from the latest commit is not sufficient because Git history keeps
prior versions.
