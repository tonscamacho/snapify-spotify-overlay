import { test, expect } from "@playwright/test";
import { parsePlayer } from "../../src/lib/spotify";
import { parseSearch } from "../../src/lib/browse";

const TOKEN = process.env.SPOTIFY_VERIFY_TOKEN;

function authHeader() {
  return { Authorization: `Bearer ${TOKEN as string}` };
}

function invalidTokenError(status: number): Error {
  return new Error(
    `SPOTIFY_VERIFY_TOKEN rejected (HTTP ${status}). Mint a fresh token: open the ` +
      `Spotify Web API Console (developer.spotify.com/console), sign in, copy the ` +
      `short-lived OAuth token (about 1 hour), and paste it into the SPOTIFY_VERIFY_TOKEN ` +
      `environment variable only. Never log, print, or commit the token.`,
  );
}

test.describe("real Spotify Web API shapes", () => {
  test.skip(
    !TOKEN,
    "Set SPOTIFY_VERIFY_TOKEN to run live API shape checks (short-lived token only).",
  );

  test("me profile carries the fields browse needs", async ({ request }) => {
    const res = await request.get("https://api.spotify.com/v1/me", { headers: authHeader() });
    if (res.status() === 401 || res.status() === 403) throw invalidTokenError(res.status());
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(typeof body.id).toBe("string");
  });

  test("player response fits parsePlayer", async ({ request }) => {
    const res = await request.get("https://api.spotify.com/v1/me/player", {
      headers: authHeader(),
    });
    if (res.status() === 401 || res.status() === 403) throw invalidTokenError(res.status());
    // 204 = valid "nothing playing" state; nothing to parse.
    if (res.status() === 204) return;
    expect(res.status()).toBe(200);
    const body = await res.json();
    const parsed = parsePlayer(body);
    expect(typeof parsed.isPlaying).toBe("boolean");
    expect(typeof parsed.progressMs).toBe("number");
    if (body && typeof body === "object" && (body as Record<string, unknown>)["item"]) {
      const item = (body as Record<string, unknown>)["item"] as Record<string, unknown>;
      expect(typeof item["id"]).toBe("string");
      expect(typeof item["uri"]).toBe("string");
      expect(parsed.track?.id).toBe(item["id"]);
    }
  });

  test("search response fits parseSearch", async ({ request }) => {
    const res = await request.get(
      "https://api.spotify.com/v1/search?q=artist%3AColdplay%20track%3AYellow&type=track&limit=5",
      { headers: authHeader() },
    );
    if (res.status() === 401 || res.status() === 403) throw invalidTokenError(res.status());
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body?.tracks?.items)).toBe(true);
    const parsed = parseSearch(body);
    expect(parsed.tracks.length).toBeGreaterThan(0);
    expect(parsed.tracks[0].uri.startsWith("spotify:track:")).toBe(true);
    expect(parsed.tracks[0].name.length).toBeGreaterThan(0);
  });

  test("lrclib has the known track in the shape lyrics needs", async ({ request }) => {
    const res = await request.get(
      "https://lrclib.net/api/get?artist_name=Coldplay&track_name=Yellow&album_name=Parachutes&duration=266",
      { headers: { "User-Agent": "snapify-verify/1.0 (local shape check)" } },
    );
    // 404 = track absent from lrclib; the lyrics pane treats that as plain/error.
    expect([200, 404]).toContain(res.status());
    if (res.status() === 404) return;
    const body = await res.json();
    expect(typeof body.id).toBe("number");
    expect(typeof body.trackName).toBe("string");
    expect(body.syncedLyrics != null || body.plainLyrics != null).toBe(true);
  });
});
