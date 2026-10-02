# Login

Sub-features: PKCE connect on port 3000, session restore from keychain,
logout clearing credentials.

How to get to it: launch the app logged out. The gate card reads
"Connect Spotify".

Driving it: press Continue, approve in the browser, the gate closes and the
stage shows panes. Restart the app: no gate, session restored. Settings >
Spotify > Logout returns to the gate.

Gotchas: port 3000 must be free during login only. `auth-error` event fires
when busy. Redirect URI must match the Spotify dashboard byte for byte.
