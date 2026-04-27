// Type declarations for foliate-js. The library ships pure JS without
// .d.ts files. We declare just enough surface area to type-check the
// thin wrappers in src/parsers/foliate.ts; the wrappers themselves
// re-shape everything to our own IngestPayload type, so consumers
// don't see these `any`s.

declare module 'foliate-js/mobi.js' {
  export const isMOBI: (file: Blob) => Promise<boolean>;
  export class MOBI {
    constructor(opts: { unzlib: (data: Uint8Array) => Uint8Array });
    open(file: Blob): Promise<unknown>;
  }
}

declare module 'foliate-js/fb2.js' {
  export const makeFB2: (blob: Blob) => Promise<unknown>;
}

declare module 'foliate-js/comic-book.js' {
  export const makeComicBook: (loader: unknown, file: Blob) => Promise<unknown>;
}

declare module 'foliate-js/epub.js' {
  export class EPUB {
    constructor(loader: unknown);
    init(): Promise<unknown>;
  }
}
