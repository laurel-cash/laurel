# live.Dockerfile -- the live testnet harness's image (docs/DEVELOPMENT.md,
# "Live testnet checks"): Rust and protoc, installed once. Installing
# protoc on every run cost 15-20 seconds a run.
#
# The base is pinned by digest, not a tag a registry can move: this image
# builds the wallet engine from Laurel's source. The source is mounted
# read-only besides, so an image that isn't what it says still can't
# change what Laurel ships. A newer base: its digest, pinned here anew.
#
#   docker build -t laurel-live -f scripts/live.Dockerfile scripts

FROM rust:1-bookworm@sha256:93ce27a88655056a51dbdd8f5f2d7ddc071c7b0070fb288a37b5a285fc83971e
RUN apt-get update -qq && apt-get install -y -qq protobuf-compiler && rm -rf /var/lib/apt/lists/*
