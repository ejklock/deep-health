export interface UploadResult {
  url: string;
  id: string;
  provider: string;
}

export interface StorageProvider {
  upload(filename: string, content: string): Promise<UploadResult>;
}
