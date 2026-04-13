// export {} makes this file a module so the global augmentation below is
// treated as an augmentation rather than a full replacement.
export {};

// Augments all Express Request variants so req.currentUser is visible globally.
declare global {
  namespace Express {
    interface Request {
      currentUser?: {
        sub: string;
        email: string;
        role: string;
        iat?: number;
        exp?: number;
        isService?: boolean;
      };
    }
  }
}
