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

type ParityType = 'none' | 'even' | 'odd' | 'mark' | 'space';

interface SerialOptions {
  baudrate: number;
  databits: number;
  stopbits: number;
  parity: ParityType;
  buffersize: number;
  rtscts: boolean;
  xon: boolean;
  xoff: boolean;
  xany: boolean;
}

const kSetControlLineState = 0x22;
const kGetLineCoding = 0x21;
const kSetLineCoding = 0x20;
const kDefaultSerialOptions: SerialOptions = {
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

const kParityIndexMapping: ParityType[] =
    ['none', 'odd', 'even', 'mark', 'space'];
const kStopbitsIndexMapping = [1, 1.5, 2];

/** a class used to control serial devices over WebUSB */
export class SerialPort {
  public in: ReadableStream<Uint8Array>;
  public out: WritableStream<Uint8Array>;

  private transferInterface_: USBInterface;
  private controlInterface_: USBInterface;
  private serialOptions_: SerialOptions;
  private device_: USBDevice;

  /**
   * constructor taking a WebUSB device that creates a SerialPort instance.
   * @param {object} device A device acquired from the WebUSB API
   * @param {object} serialOptions Optional object containing serial options
   */
  public constructor(device: USBDevice, serialOptions?: SerialOptions) {
    this.serialOptions_ = {...kDefaultSerialOptions, ...serialOptions};
    this.validateOptions();

    this.setPort(device);
  }

  /**
   * a function that opens the device and claims all interfaces needed to
   * control and communicate to and from the serial device
   * @return {Promise} A promise that will resolve when device is ready for
   * communication
   */
  public async open() {
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
        write: this.write.bind(this),
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
  public async getInfo() {
    const response = await this.device_.controlTransferIn({
      'requestType': 'class',
      'recipient': 'interface',
      'request': kGetLineCoding,
      'value': 0x00,
      'index': 0x00,
    }, 7);

    if (response.status === 'ok') {
      return this.readLineCoding(response.data!.buffer);
    }
  }

  /**
   * A function used to change the serial settings of the device
   * @param {object} options the object which carries serial settings data
   * @return {Promise} A promise that will resolve when the options are set
   */
  public setOptions(options?: SerialOptions) {
    const newOptions = {...this.serialOptions_, ...options};
    this.serialOptions_ = newOptions;
    this.validateOptions();
    return this.setSerialOptions();
  }

  /**
   * Set the device inside the class and figure out which interface is the
   * proper one for transfer and control
   * @param {object} device A device acquired from the WebUSB API
   */
  private setPort(device: USBDevice) {
    if (!SerialPort.isSerialDevice(device)) {
      throw new TypeError('This is not a serial port');
    }
    this.device_ = device;

    const transferInterface = this.getTransferInterface(device);
    if (!transferInterface) {
      throw new Error('Unable to find data transfer interface.');
    }
    this.transferInterface_ = transferInterface;

    const controlInterface = this.getControlInterface(device);
    if (!controlInterface) {
      throw new Error('Unable to find control interface.');
    }
    this.controlInterface_ = controlInterface;
  }

  /**
   * Checks the serial options for validity and throws an error if it is
   * not valid
   */
  private validateOptions() {
    if (!this.isValidBaudRate(this.serialOptions_.baudrate)) {
      throw new RangeError('invalid Baud Rate ' + this.serialOptions_.baudrate);
    }

    if (!this.isValidDataBits(this.serialOptions_.databits)) {
      throw new RangeError('invalid databits ' + this.serialOptions_.databits);
    }

    if (!this.isValidStopBits(this.serialOptions_.stopbits)) {
      throw new RangeError('invalid stopbits ' + this.serialOptions_.stopbits);
    }

    if (!this.isValidParity(this.serialOptions_.parity)) {
      throw new RangeError('invalid parity ' + this.serialOptions_.parity);
    }
  }

  /**
   * Checks the baud rate for validity
   * @param {number} baudrate the baud rate to check
   * @return {boolean} A boolean that reflects whether the baud rate is valid
   */
  private isValidBaudRate(baudrate: number) {
    return baudrate % 1 === 0;
  }

  /**
   * Checks the data bits for validity
   * @param {number} databits the data bits to check
   * @return {boolean} A boolean that reflects whether the data bits setting is
   * valid
   */
  private isValidDataBits(databits: number) {
    return kAcceptableDataBits.includes(databits);
  }

  /**
   * Checks the stop bits for validity
   * @param {number} stopbits the stop bits to check
   * @return {boolean} A boolean that reflects whether the stop bits setting is
   * valid
   */
  private isValidStopBits(stopbits: number) {
    return kAcceptableStopBits.includes(stopbits);
  }

  /**
   * Checks the parity for validity
   * @param {string} parity the parity to check
   * @return {boolean} A boolean that reflects whether the parity is valid
   */
  private isValidParity(parity: ParityType) {
    return kAcceptableParity.includes(parity);
  }

  /**
   * The function called by the writable stream upon creation
   * @param {WritableStreamDefaultController} controller The stream controller
   * @return {Promise} A Promise that is to be resolved whe this instance is
   * ready to use the writablestream
   */
  private async writeStart(controller: WritableStreamDefaultController) {
  }

  /**
   * The function called by the readable stream upon creation
   * @param {number} controller The stream controller
   */
  private async readStart_(controller: ReadableStreamDefaultController) {
    const endpoint = this.getDirectionEndpoint('in');
    if (!endpoint) {
      controller.error(new Error('No IN endpoint available.'));
      return;
    }

    (async () => {
      try {
        for (;;) {
          const result =
              await this.device_.transferIn(endpoint.endpointNumber, 64);
          controller.enqueue(result.data);
        }
      } catch (error) {
        controller.error(error.toString());
      }
    })();
  }

  /**
   * Sends data along the "out" endpoint of this
   * @param {Uint8Array} chunk the data to be sent out
   * @param {Object} controller The Object for the
   * WritableStreamDefaultController used by the WritablSstream API
   * @return {Promise} a promise that will resolve when the data is sent
   */
  private async write(
      chunk: Uint8Array,
      controller: WritableStreamDefaultController) {
    const endpoint = this.getDirectionEndpoint('out');
    if (!endpoint) {
      controller.error(new Error('No OUT endpoint available.'));
      return;
    }

    if (chunk instanceof Uint8Array) {
      try {
        await this.device_.transferOut(endpoint.endpointNumber, chunk);
      } catch (error) {
        controller.error(error.toString());
      }
    } else {
      throw new TypeError(
          'Can only send Uint8Array please use transform stream to convert ' +
          'data to Uint8Array');
    }
  }

  /**
   * sends the options alog the control interface to set them on the device
   * @return {Promise} a promise that will resolve when the options are set
   */
  private setSerialOptions() {
    return this.device_.controlTransferOut(
        {
          'requestType': 'class',
          'recipient': 'interface',
          'request': kSetLineCoding,
          'value': 0x00,
          'index': 0x00,
        },
        this.getLineCodingStructure());
  }

  /**
   * Takes in an Array Buffer that contains Line Coding according to the USB
   * CDC spec
   * @param {ArrayBuffer} buffer The data structured accoding to the spec
   * @return {object} The options
   */
  private readLineCoding(buffer: ArrayBuffer) {
    const options: SerialOptions = this.serialOptions_;
    const view = new DataView(buffer);
    options.baudrate = view.getUint32(0, true);
    options.stopbits = view.getUint8(4) < kStopbitsIndexMapping.length ?
        kStopbitsIndexMapping[view.getUint8(4)] :
        1;
    options.parity = view.getUint8(5) < kParityIndexMapping.length ?
        kParityIndexMapping[view.getUint8(5)] :
        'none';
    options.databits = view.getUint8(6);
    return options;
  }

  /**
   * Turns the serialOptions into an array buffer structured into accordance to
   * the USB CDC specification
   * @return {object} The array buffer with the Line Coding structure
   */
  private getLineCodingStructure() {
    const buffer = new ArrayBuffer(7);
    const view = new DataView(buffer);
    view.setUint32(0, this.serialOptions_.baudrate, true);
    view.setUint8(
        4, kStopbitsIndexMapping.indexOf(this.serialOptions_.stopbits));
    view.setUint8(5, kParityIndexMapping.indexOf(this.serialOptions_.parity));
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
  public static isSerialDevice(device: USBDevice) {
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
  private getControlInterface(device: USBDevice) {
    return this.getInterfaceWithClass(device, 2);
  }

  /**
   * Finds the interface used for transfering data over the serial device
   * @param {Object} device the object for a device from the WebUSB API
   * @return {object} The interface Object created from the WebUSB API that is
   * expected to handle the transfer of data.
   */
  private getTransferInterface(device: USBDevice) {
    return this.getInterfaceWithClass(device, 10);
  }

  /**
   * Utility used to get any interface on the device with a given class number
   * @param {Object} device the object for a device from the WebUSB API
   * @param {Object} classNumber The class number you want to find
   * @return {object} The interface Object created from the WebUSB API that is
   * has the specified classNumber
   */
  private getInterfaceWithClass(device: USBDevice, classNumber: number) {
    let interfaceWithClass;
    device.configuration!.interfaces.forEach((deviceInterface) => {
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
  private getDirectionEndpoint(direction: USBDirection):
      USBEndpoint | undefined {
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

/** implementation of the global navigator.serial object */
class Serial {
  /** requests permission to access a new port */
  async requestPort() {
    const filters = [
      {classCode: 10},
    ];
    const device = await navigator.usb.requestDevice({'filters': filters});
    const port = new SerialPort(device);
    return port;
  }

  /** gets the list of available ports */
  async getPorts() {
    const devices = await navigator.usb.getDevices();
    const serialDevices: SerialPort[] = [];
    devices.forEach((device) => {
      if (SerialPort.isSerialDevice(device)) {
        serialDevices.push(new SerialPort(device));
      }
    });
    return serialDevices;
  }
}

/* an object to be used for starting the serial workflow */
export const serial = new Serial();
