// Shared by the backend and browser. Storage rules enforce this byte limit too.
export const MAX_UPLOAD_GIB = 20;
export const MAX_UPLOAD_BYTES = MAX_UPLOAD_GIB * 1024 ** 3;
export const MAX_UPLOAD_LABEL = `${MAX_UPLOAD_GIB} GiB`;
export const VERIFICATION_TIMEOUT_SECONDS = 300;
