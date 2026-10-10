import { describe, expect, it } from "vitest";
import { buildMasterPlaylist, parseHlsManifest, recordingHlsPrefix, signMediaPlaylist } from "./recording-hls";

const manifestJson = JSON.stringify({
  version: 1,
  renditions: [
    { name: "1440p", width: 2560, height: 1440, bandwidth: 5_100_000, averageBandwidth: 900_000, codecs: "avc1.640032,mp4a.40.2", frameRate: 30 },
    { name: "480p", width: 854, height: 480, bandwidth: 700_000, averageBandwidth: 250_000, codecs: "avc1.64001e,mp4a.40.2", frameRate: 30 },
    { name: "1080p", width: 1920, height: 1080, bandwidth: 2_500_000, averageBandwidth: 600_000, codecs: "avc1.640028,mp4a.40.2", frameRate: 30 },
    { name: "720p", width: 1280, height: 720, bandwidth: 1_300_000, averageBandwidth: 400_000, codecs: "avc1.64001f,mp4a.40.2", frameRate: 30 },
  ],
});

describe("recordingHlsPrefix", () => {
  it("maps the recording object to its own hls folder", () => {
    expect(recordingHlsPrefix("recordings/00314284-69bc-4990-94c4-e64a41a13f9a.mp4")).toBe("hls/00314284-69bc-4990-94c4-e64a41a13f9a/");
  });

  it("refuses keys that could escape the folder", () => {
    expect(() => recordingHlsPrefix("recordings/../secret.mp4")).toThrow();
    expect(() => recordingHlsPrefix("")).toThrow();
  });
});

describe("parseHlsManifest", () => {
  it("accepts the transcoder's manifest", () => {
    expect(parseHlsManifest(manifestJson)?.renditions.map((rendition) => rendition.name)).toEqual(["1440p", "480p", "1080p", "720p"]);
  });

  it("treats anything unexpected as no HLS, so the MP4 keeps playing", () => {
    expect(parseHlsManifest("not json")).toBeNull();
    expect(parseHlsManifest(JSON.stringify({ version: 2, renditions: [] }))).toBeNull();
    expect(parseHlsManifest(JSON.stringify({ version: 1, renditions: [{ name: "../x", width: 1, height: 1, bandwidth: 1 }] }))).toBeNull();
    expect(parseHlsManifest(JSON.stringify({ version: 1, renditions: [{ name: "720p", width: 1280, height: 720 }] }))).toBeNull();
  });

  it("drops a codecs string that could break the playlist instead of passing it through", () => {
    const manifest = parseHlsManifest(JSON.stringify({ version: 1, renditions: [{ name: "720p", width: 1280, height: 720, bandwidth: 1, codecs: "avc1\"\n#EXT-X-ENDLIST" }] }));
    expect(manifest?.renditions[0].codecs).toBeNull();
  });
});

describe("buildMasterPlaylist", () => {
  it("starts on 720p for a fast start, then lists the rest from the highest down", () => {
    const manifest = parseHlsManifest(manifestJson)!;
    const playlist = buildMasterPlaylist(manifest, (name) => `${name}.m3u8`);
    const uris = playlist.split("\n").filter((line) => line.endsWith(".m3u8"));
    expect(uris).toEqual(["720p.m3u8", "1440p.m3u8", "1080p.m3u8", "480p.m3u8"]);
    expect(playlist).toContain('#EXT-X-STREAM-INF:BANDWIDTH=1300000,AVERAGE-BANDWIDTH=400000,RESOLUTION=1280x720,CODECS="avc1.64001f,mp4a.40.2",FRAME-RATE=30.000');
  });
});

describe("signMediaPlaylist", () => {
  const stored = [
    "#EXTM3U",
    "#EXT-X-VERSION:7",
    "#EXT-X-TARGETDURATION:10",
    "#EXT-X-PLAYLIST-TYPE:VOD",
    '#EXT-X-MAP:URI="init.mp4"',
    "#EXTINF:10.000000,",
    "seg_00001.m4s",
    "#EXTINF:4.200000,",
    "seg_00002.m4s",
    "#EXT-X-ENDLIST",
  ].join("\n");

  it("signs the init section and every segment, keeping the rest as is", async () => {
    const signed = await signMediaPlaylist(stored, async (file) => `https://signed/${file}?sig=1`);
    expect(signed).toContain('#EXT-X-MAP:URI="https://signed/init.mp4?sig=1"');
    expect(signed).toContain("https://signed/seg_00001.m4s?sig=1");
    expect(signed).toContain("https://signed/seg_00002.m4s?sig=1");
    expect(signed).toContain("#EXT-X-ENDLIST");
    expect(signed).not.toMatch(/^seg_/m);
  });

  it("never signs a path outside the rendition folder", async () => {
    const sign = async (file: string) => `https://signed/${file}`;
    await expect(signMediaPlaylist(stored.replace("seg_00002.m4s", "../../recordings/other.mp4"), sign)).rejects.toThrow();
    await expect(signMediaPlaylist(stored.replace("seg_00002.m4s", "https://evil.example/x.m4s"), sign)).rejects.toThrow();
    await expect(signMediaPlaylist(stored.replace('URI="init.mp4"', 'URI="../init.mp4"'), sign)).rejects.toThrow();
    await expect(signMediaPlaylist("not a playlist", sign)).rejects.toThrow();
  });
});
