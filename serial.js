/*
 * Copyright 2019 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in
 * compliance with the License. You may obtain a copy of
 * the License at
 *
 *    https://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in
 * writing, software distributed under the License is
 * distributed on an "AS IS" BASIS, WITHOUT WARRANTIES
 * OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing
 * permissions and limitations under the License.
 */
'use strict';

const kSetControlLineState = 0x22;
const kGetLineCoding = 0x21;
const kSetLineCoding = 0x20;
const kDefaultSerialOptions = {
  baudrate: 115200,
  databits: 8,
  stopbits: 1,
  parity: 'none',
  buffersize: 255,
  rtscts: false,
  xon: false,
  xoff: false,
  xany: false,
};
const kAcceptableDataBits = [16, 8, 7, 6, 5];
const kAcceptableStopBits = [1, 2];
const kAcceptableParity = ['none', 'even', 'mark', 'odd', 'space'];

const kParityIndexMapping = ['none', 'odd', 'even', 'mark', 'space'];
const kStopbitsIndexMapping = [1, 1.5, 2];

/** a class used to control serial devices over WebUSB */
class SerialPort {
  /**
   * constructor taking a WebUSB device that creates a SerialPort instance.
   * @param {object} device A device acquired from the WebUSB API
   * @param {object} serialOptions Optional object containing serial options
   */
  constructor(device, serialOptions = {}) {
    /** @private {number} */
    this.transferInterface_ = 0;
    /** @private {number} */
    this.controlInterface_ = 0;
    /** @private {number} */
    this.serialOptions_ =
        Object.assign({}, kDefaultSerialOptions, serialOptions);
    /** @private {object} */
    this.device_ = {};
    this.validateOptions_();

    this.setPort_(device);
  }

  /**
   * a function that opens the device and claims all interfaces needed to
   * control and communicate to and from the serial device
   * @return {Promise} A promise that will resolve when device is ready for
   * communication
   */
  async open() {
    try {
      await this.device_.open();
      if (this.device_.configuration === null) {
        await this.device_.selectConfiguration(1);
      }
      await this.device_.claimInterface(this.controlInterface_.interfaceNumber);
      await this.device_.claimInterface(
          this.transferInterface_.interfaceNumber);
      await this.setOptions();
      await this.device_.controlTransferOut({
        'requestType': 'class',
        'recipient': 'interface',
        'request': kSetControlLineState,
        'value': 0x01,
        'index': this.controlInterface_.interfaceNumber,
      });
      this.in = new ReadableStream({start: this.readStart_.bind(this)});
      this.out = new WritableStream({
        write: this.write_.bind(this),
      });
    } catch (error) {
      throw new Error('Error setting up device: ' + error.toString());
    }
  }

  /**
   * A function used the get the options directoly from the device
   * @return {Promise} A promise that will resolve with an object containing
   * the device serial options
   */
  getInfo() {
    return this.device_
        .controlTransferIn(
            {
              'requestType': 'class',
              'recipient': 'interface',
              'request': kGetLineCoding,
              'value': 0x00,
              'index': 0x00,
            },
            7)
        .then((response) => {
          return this.readLineCoding_(response.data.buffer);
        });
  }

  /**
   * A function used to change the serial settings of the device
   * @param {object} options the object which carries serial settings data
   * @return {Promise} A promise that will resolve when the options are set
   */
  setOptions(options) {
    const newOptions = Object.assign({}, this.serialOptions_, options);
    this.serialOptions_ = newOptions;
    this.validateOptions_();
    return this.setSerialOptions_();
  }

  /**
   * Set the device inside the class and figure out which interface is the
   * proper one for transfer and control
   * @param {object} device A device acquired from the WebUSB API
   */
  setPort_(device) {
    if (!SerialPort.isSerialDevice_(device)) {
      throw new TypeError('This is not a serial port');
    }
    this.device_ = device;
    this.transferInterface_ = this.getTransferInterface_(device);
    this.controlInterface_ = this.getControlInterface_(device);
  }

  /**
   * Checks the serial options for validity and throws an error if it is
   * not valid
   */
  validateOptions_() {
    if (!this.isValidBaudRate_(this.serialOptions_.baudrate)) {
      throw new RangeError('invalid Baud Rate ' + this.serialOptions_.baudrate);
    }

    if (!this.isValidDataBits_(this.serialOptions_.databits)) {
      throw new RangeError('invalid databits ' + this.serialOptions_.databits);
    }

    if (!this.isValidStopBits_(this.serialOptions_.stopbits)) {
      throw new RangeError('invalid stopbits ' + this.serialOptions_.stopbits);
    }

    if (!this.isValidParity_(this.serialOptions_.parity)) {
      throw new RangeError('invalid parity ' + this.serialOptions_.parity);
    }
  }

  /**
   * Checks the baud rate for validity
   * @param {number} baudrate the baud rate to check
   * @return {boolean} A boolean that reflects whether the baud rate is valid
   */
  isValidBaudRate_(baudrate) {
    return baudrate % 1 === 0;
  }

  /**
   * Checks the data bits for validity
   * @param {number} databits the data bits to check
   * @return {boolean} A boolean that reflects whether the data bits setting is
   * valid
   */
  isValidDataBits_(databits) {
    return acceptableDataBits.includes(databits);
  }

  /**
   * Checks the stop bits for validity
   * @param {number} stopbits the stop bits to check
   * @return {boolean} A boolean that reflects whether the stop bits setting is
   * valid
   */
  isValidStopBits_(stopbits) {
    return acceptableStopBits.includes(stopbits);
  }

  /**
   * Checks the parity for validity
   * @param {number} parity the parity to check
   * @return {boolean} A boolean that reflects whether the parity is valid
   */
  isValidParity_(parity) {
    return acceptableParity.includes(parity);
  }

  /**
   * The function called by the writable stream upon creation
   * @param {number} controller The stream controller
   * @return {Promise} A Promise that is to be resolved whe this instance is
   * ready to use the writablestream
   */
  writeStart_(controller) {
    return new Promise((resolve, reject) => {
      if (this.device_) {
        resolve();
      }
    });
  }

  /**
   * The function called by the readable stream upon creation
   * @param {number} controller The stream controller
   */
  readStart_(controller) {
    const readLoop = () => {
      this.device_
          .transferIn(this.getDirectionEndpoint_('in').endpointNumber, 64)
          .then(
              (result) => {
                controller.enqueue(result.data);
                readLoop();
              },
              (error) => {
                controller.error(error.toString());
              });
    };
    readLoop();
  }

  /**
   * Sends data along the "out" endpoint of this
   * @param {ArrayBuffer} chunk the data to be sent out
   * @param {Object} controller The Object for the
   * WritableStreamDefaultController used by the WritablSstream API
   * @return {Promise} a promise that will resolve when the data is sent
   */
  write_(chunk, controller) {
    if (chunk instanceof ArrayBuffer) {
      return this.device_
          .transferOut(this.getDirectionEndpoint_('out').endpointNumber, chunk)
          .catch((error) => {
            controller.error(error.toString());
          });
    } else {
      throw new TypeError(
          'Can only send ArrayBuffers please use transform stream to convert ' +
          'data to ArrayBuffer');
    }
  }

  /**
   * sends the options alog the control interface to set them on the device
   * @return {Promise} a promise that will resolve when the options are set
   */
  setSerialOptions_() {
    return this.device_.controlTransferOut(
        {
          'requestType': 'class',
          'recipient': 'interface',
          'request': kSetLineCoding,
          'value': 0x00,
          'index': 0x00,
        },
        this.getLineCodingStructure_());
  }

  /**
   * Takes in an Array Buffer that contains Line Coding according to the USB
   * CDC spec
   * @param {ArrayBuffer} buffer The data structured accoding to the spec
   * @return {object} The options
   */
  readLineCoding_(buffer) {
    const options = {};
    const view = new DataView(buffer);
    options.baudrate = view.getUint32(0, true);
    options.stopbits = view.getUint8(4) < stopbitsIndexMapping.length ?
        stopbitsIndexMapping[view.getUint8(4)] :
        1;
    options.parity = view.getUint8(5) < parityIndexMapping.length ?
        parityIndexMapping[view.getUint8(5)] :
        'none';
    options.databits = view.getUint8(6);
    return options;
  }

  /**
   * Turns the serialOptions into an array buffer structured into accordance to
   * the USB CDC specification
   * @return {object} The array buffer with the Line Coding structure
   */
  getLineCodingStructure_() {
    const buffer = new ArrayBuffer(7);
    const view = new DataView(buffer);
    view.setUint32(0, this.serialOptions_.baudrate, true);
    view.setUint8(
        4, stopbitsIndexMapping.indexOf(this.serialOptions_.stopbits));
    view.setUint8(5, parityIndexMapping.indexOf(this.serialOptions_.parity));
    view.setUint8(6, this.serialOptions_.databits);
    return buffer;
  }

  /**
   * Check whether the passed device is a serial device with the proper
   * interface classes
   * @param {object} device the device acquired from the WebUSB API
   * @return {boolean} the boolean indicating whether the device is structured
   * as a serial device
   */
  static isSerialDevice_(device) {
    if (!(device.configurations instanceof Array)) {
      return false;
    }

    let hasInterfaceClassTen = false;
    let hasInterfaceClassTwo = false;

    device.configurations.forEach((config) => {
      if (config.interfaces instanceof Array) {
        config.interfaces.forEach((thisInterface) => {
          if (thisInterface.alternates instanceof Array) {
            thisInterface.alternates.forEach((alternate) => {
              if (alternate.interfaceClass === 10) {
                hasInterfaceClassTen = true;
              }
              if (alternate.interfaceClass === 2) {
                hasInterfaceClassTwo = true;
              }
            });
          }
        });
      }
    });
    return hasInterfaceClassTen && hasInterfaceClassTwo;
  }

  /**
   * Finds the interface used for controlling the serial device
   * @param {Object} device the object for a device from the WebUSB API
   * @return {object} The interface Object created from the WebUSB API that is
   * expected to handle the control of the Serial Device
   */
  getControlInterface_(device) {
    return this.getInterfaceWithClass_(device, 2);
  }

  /**
   * Finds the interface used for transfering data over the serial device
   * @param {Object} device the object for a device from the WebUSB API
   * @return {object} The interface Object created from the WebUSB API that is
   * expected to handle the transfer of data.
   */
  getTransferInterface_(device) {
    return this.getInterfaceWithClass_(device, 10);
  }

  /**
   * Utility used to get any interface on the device with a given class number
   * @param {Object} device the object for a device from the WebUSB API
   * @param {Object} classNumber The class number you want to find
   * @return {object} The interface Object created from the WebUSB API that is
   * has the specified classNumber
   */
  getInterfaceWithClass_(device, classNumber) {
    let interfaceWithClass;
    device.configuration.interfaces.forEach((deviceInterface) => {
      deviceInterface.alternates.forEach((alternate) => {
        if (alternate.interfaceClass === classNumber) {
          interfaceWithClass = deviceInterface;
        }
      });
    });
    return interfaceWithClass;
  }

  /**
   * Utility function to get an endpoint from the Tranfer Interface that
   * has the given direction
   * @param {String} direction A string either "In" or "Out" specifying the
   * direction requested
   * @return {object} The Endpoint Object created from the WebUSB API that is
   * has the specified direction
   */
  getDirectionEndpoint_(direction) {
    let correctEndpoint;
    this.transferInterface_.alternates.forEach((alternate) => {
      alternate.endpoints.forEach((endpoint) => {
        if (endpoint.direction == direction) {
          correctEndpoint = endpoint;
        }
      });
    });
    return correctEndpoint;
  }
}

/* an object to be used for starting the serial workflow */
const serial = {
  requestPort: function() {
    const filters = [
      {classCode: 10},
    ];
    return navigator.usb.requestDevice({'filters': filters})
        .then(async (device) => {
          const port = new SerialPort(device);
          return port;
        });
  },

  SerialPort: SerialPort,
  getPorts: function() {
    return navigator.usb.getDevices().then((devices) => {
      const serialDevices = [];
      devices.forEach((device) => {
        if (SerialPort.isSerialDevice_(device)) {
          serialDevices.push(new SerialPort(device));
        }
      });
      return serialDevices;
    });
  },
};

/* eslint-disable no-undef */
if (typeof exports !== 'undefined') {
  if (typeof module !== 'undefined' && module.exports) {
    exports = module.exports = serial;
  }
  exports.serial = serial;
}
