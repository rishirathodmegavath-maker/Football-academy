// A one-shot note that a person has just signed in, so the academy list can
// open their academy at once when they have exactly one (the same start as a
// product where the owner signs in and lands in the academy). It lives in this
// tab only, is read once, and is never trusted for access: the server still
// checks the membership on every request.
const KEY = "sportozen:just-signed-in";

export function markJustSignedIn() {
  try {
    window.sessionStorage.setItem(KEY, "1");
  } catch {
    // Storage can be blocked; the academy list then simply shows as usual.
  }
}

/** True once after a sign-in; reading it clears it. */
export function takeJustSignedIn(): boolean {
  try {
    const value = window.sessionStorage.getItem(KEY) === "1";
    window.sessionStorage.removeItem(KEY);
    return value;
  } catch {
    return false;
  }
}
