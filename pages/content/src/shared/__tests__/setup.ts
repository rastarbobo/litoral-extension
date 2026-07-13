// Minimal jsdom polyfills for DOM utils tests.
//
// jsdom does not implement `DataTransfer`, and `HTMLInputElement.prototype.files`
// pre-checks the assigned value against its internal FileList class. To exercise
// `uploadMedia` in tests, we install a minimal DataTransfer stub AND redefine
// `files` on the prototype so any FileList-like value is accepted.

// 1. DataTransfer polyfill
class TestDataTransfer {
  files: File[] = [];
  items = {
    add: (file: File) => {
      this.files.push(file);
    },
  };
}
(globalThis as unknown as { DataTransfer: typeof TestDataTransfer }).DataTransfer = TestDataTransfer;

// 2. HTMLInputElement.prototype.files shim
//    Replace jsdom's typed setter with a permissive one that stores any FileList.
declare global {
  interface FileList {
    item: (index: number) => File | null;
  }
}
const fileStore = new WeakMap<HTMLInputElement, FileList>();
Object.defineProperty(HTMLInputElement.prototype, 'files', {
  configurable: true,
  get() {
    return fileStore.get(this) ?? Object.freeze(Object.assign([] as unknown as FileList, { item: () => null }));
  },
  set(v: FileList) {
    fileStore.set(this, v);
  },
});

export {};
