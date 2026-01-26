import { WasmRunner } from "../tools/wasm_runner.js";
import { XfoilInput } from "./xfoil_input.js";
import { parseXfoilOutput } from "./output_parser.js";

class WebXFOIL {
  constructor(runner, loadOptions = null) {
    this._runner = runner;
    this._loadOptions = loadOptions;
  }

  static async load(options = {}) {
    const loadOptions = {
      exportName: "XfoilModule",
      ...options,
    };
    const runner = await WasmRunner.load("xfoil", loadOptions);
    return new WebXFOIL(runner, loadOptions);
  }

  static input(lines) {
    return new XfoilInput(lines);
  }

  static get Input() {
    return XfoilInput;
  }

  get FS() {
    return this._runner.FS;
  }

  input(lines) {
    return new XfoilInput(lines);
  }

  writeFile(path, data) {
    this._runner.writeFile(path, data);
  }

  readFile(path, encoding = "utf8") {
    return this._runner.readFile(path, encoding);
  }

  run(sessionText, options = {}) {
    const { scalarKeys, ...runnerOptions } = options;
    const raw = this._runner.runWithStdin(sessionText, runnerOptions);
    const output = parseXfoilOutput(raw, { scalarKeys });
    return { raw, output };
  }

  async reset() {
    if (!this._loadOptions) {
      throw new Error("Cannot reset without load options.");
    }
    if (this._runner && typeof this._runner.destroy === "function") {
      this._runner.destroy();
    }
    this._runner = await WasmRunner.load("xfoil", this._loadOptions);
  }

  destroy() {
    if (this._runner && typeof this._runner.destroy === "function") {
      this._runner.destroy();
    }
  }
}

export { WebXFOIL };
