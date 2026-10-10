import { describe, expect, it } from "vitest";
import { codecsString, parseProbe, planRenditions, playlistBandwidth, type Probe } from "./transcode.ts";

const egressProbe: Probe = parseProbe({
  streams: [
    { codec_type: "video", codec_name: "h264", profile: "Main", level: 50, width: 2560, height: 1440, avg_frame_rate: "30/1" },
    { codec_type: "audio", codec_name: "aac", profile: "LC", avg_frame_rate: "0/0" },
  ],
  format: { duration: "5653.9" },
});

describe("parseProbe", () => {
  it("reads what ffprobe reports for a LiveKit egress recording", () => {
    expect(egressProbe.durationSeconds).toBeCloseTo(5653.9);
    expect(egressProbe.video).toMatchObject({ codecName: "h264", profile: "Main", level: 50, width: 2560, height: 1440, frameRate: 30 });
    expect(egressProbe.audio).toMatchObject({ codecName: "aac", profile: "LC", frameRate: null });
  });
});

describe("planRenditions", () => {
  it("cuts the 1440p original as is and encodes 1080p, 720p and 480p", () => {
    expect(planRenditions(egressProbe)).toEqual([
      { name: "1440p", width: 2560, height: 1440, copy: true, maxrateKbps: 6000 },
      { name: "1080p", width: 1920, height: 1080, copy: false, maxrateKbps: 2500 },
      { name: "720p", width: 1280, height: 720, copy: false, maxrateKbps: 1200 },
      { name: "480p", width: 854, height: 480, copy: false, maxrateKbps: 600 },
    ]);
  });

  it("keeps an odd source size (an OBS 1920×1032 window) and only adds smaller qualities", () => {
    const plans = planRenditions({ ...egressProbe, video: { ...egressProbe.video!, width: 1920, height: 1032 } });
    expect(plans.map((plan) => [plan.name, plan.width, plan.copy])).toEqual([["1032p", 1920, true], ["720p", 1340, false], ["480p", 894, false]]);
  });

  it("re-encodes the full size too when the source isn't H.264", () => {
    expect(planRenditions({ ...egressProbe, video: { ...egressProbe.video!, codecName: "vp8" } })[0].copy).toBe(false);
  });

  it("refuses a file without video", () => {
    expect(() => planRenditions({ ...egressProbe, video: null })).toThrow();
  });
});

describe("codecsString", () => {
  it("describes egress Main 5.0 and x264 High with AAC-LC audio", () => {
    expect(codecsString(egressProbe.video, egressProbe.audio)).toBe("avc1.4d0032,mp4a.40.2");
    expect(codecsString({ ...egressProbe.video!, profile: "High", level: 31 }, egressProbe.audio)).toBe("avc1.64001f,mp4a.40.2");
  });

  it("leaves it out rather than guessing (players then probe the stream themselves)", () => {
    expect(codecsString({ ...egressProbe.video!, profile: "High 4:4:4 Predictive" }, egressProbe.audio)).toBeNull();
    expect(codecsString(egressProbe.video, { ...egressProbe.audio!, profile: "unknown" })).toBeNull();
    expect(codecsString(egressProbe.video, null)).toBe("avc1.4d0032");
  });
});

describe("playlistBandwidth", () => {
  it("takes the peak per segment, ignoring a sub-second tail, and the overall average", () => {
    const playlist = ["#EXTM3U", '#EXT-X-MAP:URI="init.mp4"', "#EXTINF:10.0,", "a.m4s", "#EXTINF:10.0,", "b.m4s", "#EXTINF:0.2,", "c.m4s", "#EXT-X-ENDLIST"].join("\n");
    const sizes: Record<string, number> = { "a.m4s": 1_000_000, "b.m4s": 3_000_000, "c.m4s": 500_000 };
    const result = playlistBandwidth(playlist, (file) => sizes[file]);
    expect(result.peak).toBe(2_400_000);
    expect(result.average).toBe(Math.round((4_500_000 * 8) / 20.2));
  });
});
