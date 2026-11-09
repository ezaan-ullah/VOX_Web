# M2D Music Dashboard: demo for the slide 20 video

A standalone version of the dashboard's **Demo** tab (report ch. 4, Figs. 4.4–4.5). You choose a task, give an audio clip, play it, and run it. The site then shows each processing step from Fig. 6.4 and the task-specific output.

- **Computed from the uploaded file:** the file checks (with the UC-03 error messages), decoding, the waveform, playback, mono 16 kHz resampling and the 80-band log-mel spectrogram of the first 6.08 s.
- **Hardcoded:** the model outputs, the step timings, the device and the inference time. All of these live in `demo-data.js`.

## Run it

```sh
./start-demo.sh            # opens a chrome-less 1920x1080 Chrome window
./start-demo.sh speed=0.8  # slows the processing animation down (0.25–4)
```

The window closes the local server when you close it. Opening `index.html` directly also works for uploading and playing a file.

## Recording take

1. `./start-demo.sh`, then press F11 for full screen if you want no title bar.
2. Click **Tagging** or keep **Genre**.
3. Drag `audio/Volatile Reaction.mp3` onto the drop area, or use **Browse files**.
4. Press play for a few seconds, then pause.
5. Click **Run prediction**. The steps take about 9 s at normal speed, then the output appears.
6. Press **R** to reset everything for another take.

The track is "Volatile Reaction" by Kevin MacLeod (incompetech.com), CC BY 4.0. Its credit is shown in the file card and in `CREDITS.txt`; keep it visible in the video or credit it on the slide.

## Editing the outputs

Every number on screen comes from `demo-data.js`: the scores per task and model, the step names and times, and the inference time. If you use a different clip, change the labels there so they match what the audience hears.

## Files

| File | Role |
|---|---|
| `index.html`, `styles.css` | Layout and styles (Lato, Vox maroon) |
| `app.js` | Flow, player, pipeline animation, output |
| `dsp.js` | Decoding, resampling, waveform peaks, log-mel |
| `demo-data.js` | Hardcoded outputs and timings |
| `start-demo.sh` | Local server and recording window |
