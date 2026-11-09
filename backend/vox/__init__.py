"""Vox: inference, probes and database for the M2D Music Dashboard.

The package works without the web server, for example from a notebook:

    from vox.audio import load_window
    from vox.encoder import Encoder
    from vox.probes import Probe

    clip = load_window("song.mp3")
    emb = Encoder("path/to/checkpoint.pth").embed(clip.samples).embedding
    print(Probe.load("probes/original/genre.pt").top(emb, 5))
"""
