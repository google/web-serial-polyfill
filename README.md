# Serial API Polyfill

An implementation of the [Web Serial API](https://wicg.github.io/serial) on top
of the [WebUSB API](https://wicg.github.io/webusb) for use with USB-to-serial
adapters. Use of this library is limited to hardware and platforms where the
device is accessible via the WebUSB API because it has not been claimed by a
built-in device driver. This project was used to prototype the design of
the Web Serial API and remains useful for platforms (such as Android) which
support the WebUSB API but do not support the Web Serial API.

This is also available as an npm package
[here](https://www.npmjs.com/package/web-serial-polyfill) for convenience.

A demo of this library is provided as part of the
[serial terminal demo](https://github.com/GoogleChromeLabs/serial-terminal)
and can be activated by clicking the
"[Switch to API polyfill](https://googlechromelabs.github.io/serial-terminal/?polyfill)"
link.
