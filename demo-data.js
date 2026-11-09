/*
 * Every hardcoded value the demo shows lives here, so a different clip only needs edits in this file.
 * Scores are illustrative: the dashboard spec (report ch. 4) defines what is shown, not these numbers.
 */
window.DEMO = {
  maxBytes: 10 * 1024 * 1024,
  windowSeconds: 6.08,
  device: "GPU (NVIDIA RTX A4000)",

  // How long each pipeline step stays on screen, in ms, before ?speed= is applied.
  // The "measured" times are the ones printed beside each step.
  steps: [
    { id: "check",   name: "Check the file",       shown: 900,  measured: "6 ms" },
    { id: "decode",  name: "Decode and resample",  shown: 1500, measured: "138 ms" },
    { id: "window",  name: "Keep first 6.08 s",    shown: 1300, measured: "1 ms" },
    { id: "logmel",  name: "Log-mel spectrogram",  shown: 1900, measured: "19 ms" },
    { id: "encoder", name: "Frozen M2D encoder",   shown: 2300, measured: "618 ms" },
    { id: "probe",   name: "Linear probe",         shown: 1300, measured: "3 ms" },
  ],

  models: {
    further:  { name: "Further pre-trained M2D", detail: "M2D-X-Music on 10,000 FMA tracks", inference: "0.84 s" },
    original: { name: "Original M2D",           detail: "Pre-trained on AudioSet only",     inference: "0.81 s" },
  },

  tasks: {
    genre: {
      name: "Genre", dataset: "GTZAN", size: "10 genres", classes: 10,
      title: "Top 5 genres", probeLabel: "10 genre scores",
      scores: {
        further:  [["rock", 0.71], ["metal", 0.12], ["blues", 0.07], ["country", 0.04], ["pop", 0.03]],
        original: [["rock", 0.58], ["metal", 0.18], ["blues", 0.10], ["country", 0.06], ["disco", 0.04]],
      },
    },
    tagging: {
      name: "Tagging", dataset: "MagnaTagATune", size: "50 tags", classes: 50, threshold: 0.5,
      title: "Ten highest tag scores", probeLabel: "50 tag scores",
      scores: {
        further:  [["rock", 0.92], ["guitar", 0.88], ["drums", 0.79], ["loud", 0.66], ["no vocals", 0.58],
                   ["fast", 0.47], ["metal", 0.41], ["beat", 0.27], ["electronic", 0.14], ["synth", 0.09]],
        original: [["rock", 0.86], ["guitar", 0.83], ["drums", 0.71], ["loud", 0.52], ["fast", 0.49],
                   ["no vocals", 0.44], ["metal", 0.36], ["beat", 0.31], ["electronic", 0.17], ["techno", 0.10]],
      },
    },
    instrument: {
      name: "Instrument", dataset: "NSynth", size: "11 families", classes: 11,
      title: "Top 3 instrument families", probeLabel: "11 family scores",
      note: "These probes were trained on single isolated notes from NSynth, so on a full mix the output is illustrative.",
      scores: {
        further:  [["guitar", 0.64], ["bass", 0.17], ["keyboard", 0.08]],
        original: [["guitar", 0.52], ["bass", 0.21], ["organ", 0.09]],
      },
    },
    pitch: {
      name: "Pitch", dataset: "NSynth", size: "MIDI pitch", classes: 112,
      title: "Top 3 pitches", probeLabel: "112 pitch scores",
      note: "These probes were trained on single isolated notes from NSynth, so on a full mix the output is illustrative.",
      // [MIDI number, probability]; the note name and frequency 440 * 2^((m - 69) / 12) are computed.
      scores: {
        further:  [[40, 0.19], [41, 0.14], [43, 0.11]],
        original: [[40, 0.15], [45, 0.12], [43, 0.10]],
      },
    },
  },

  // Credit shown when the bundled track is used (CC BY 4.0 requires it).
  credits: {
    "Volatile Reaction.mp3": "“Volatile Reaction” Kevin MacLeod (incompetech.com), licensed under CC BY 4.0",
  },
};
