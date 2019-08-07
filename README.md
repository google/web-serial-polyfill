# Serial API Polyfill

An implementation of the [Serial API](https://wicg.github.io/serial) on top of
the [WebUSB API](https://wicg.github.io/webusb) for use with USB-to-serial
adapters. Use of this library is limited to hardware and platforms where the
device is accessible via the WebUSB API because it has not been claimed by a
built-in device driver. This project will be used to prototype the design of
the Serial API.

This is also available as an npm package [here](https://www.npmjs.com/package/web-serial-polyfill) for convenience.
