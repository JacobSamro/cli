import archiver from "archiver";
import * as fs from "node:fs";
import * as path from "node:path";
import { createWriteStream, statSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import ignore, { type Ignore } from "ignore";

export interface ZipProgress {
	processedBytes: number;
	totalBytes: number;
	percentage: number;
	currentFile: string;
}

export type ProgressCallback = (progress: ZipProgress) => void;

/**
 * Default patterns to always ignore (in addition to .gitignore)
 */
const DEFAULT_IGNORE_PATTERNS = [
	".git",
	".DS_Store",
	"__MACOSX",
];

/**
 * Load and parse .gitignore file, returning an ignore instance
 */
function loadGitignore(rootPath: string): Ignore {
	const ig = ignore();

	// Add default patterns
	ig.add(DEFAULT_IGNORE_PATTERNS);

	// Check for .gitignore file
	const gitignorePath = path.join(rootPath, ".gitignore");
	if (fs.existsSync(gitignorePath)) {
		try {
			const gitignoreContent = fs.readFileSync(gitignorePath, "utf-8");
			ig.add(gitignoreContent);
		} catch {
			// Ignore errors reading .gitignore
		}
	}

	// Check for .dockerignore as well (useful for deployments)
	const dockerignorePath = path.join(rootPath, ".dockerignore");
	if (fs.existsSync(dockerignorePath)) {
		try {
			const dockerignoreContent = fs.readFileSync(dockerignorePath, "utf-8");
			ig.add(dockerignoreContent);
		} catch {
			// Ignore errors reading .dockerignore
		}
	}

	return ig;
}

/**
 * Recursively collect all files respecting gitignore rules
 */
function collectFiles(
	rootPath: string,
	currentPath: string,
	ig: Ignore,
	files: { absolutePath: string; relativePath: string; size: number }[]
): void {
	const entries = readdirSync(currentPath, { withFileTypes: true });

	for (const entry of entries) {
		const absolutePath = path.join(currentPath, entry.name);
		const relativePath = path.relative(rootPath, absolutePath);

		// Check if this path should be ignored
		// For directories, we need to check with trailing slash
		const checkPath = entry.isDirectory() ? `${relativePath}/` : relativePath;

		if (ig.ignores(checkPath)) {
			continue;
		}

		if (entry.isDirectory()) {
			collectFiles(rootPath, absolutePath, ig, files);
		} else if (entry.isFile()) {
			try {
				const stats = statSync(absolutePath);
				files.push({
					absolutePath,
					relativePath,
					size: stats.size,
				});
			} catch {
				// Skip files we can't stat
			}
		}
	}
}

/**
 * Create a ZIP archive from a folder, respecting .gitignore rules
 */
export async function createZipFromFolder(
	folderPath: string,
	progressCallback?: ProgressCallback
): Promise<string> {
	return new Promise((resolve, reject) => {
		// Validate folder exists
		if (!fs.existsSync(folderPath)) {
			reject(new Error(`Folder does not exist: ${folderPath}`));
			return;
		}

		const stats = fs.statSync(folderPath);
		if (!stats.isDirectory()) {
			reject(new Error(`Path is not a directory: ${folderPath}`));
			return;
		}

		// Load gitignore rules
		const ig = loadGitignore(folderPath);

		// Collect all files to include
		const files: { absolutePath: string; relativePath: string; size: number }[] = [];
		collectFiles(folderPath, folderPath, ig, files);

		if (files.length === 0) {
			reject(new Error("No files to include in ZIP (all files may be ignored by .gitignore)"));
			return;
		}

		// Calculate total size for progress
		const totalBytes = files.reduce((sum, f) => sum + f.size, 0);

		// Create temp file for ZIP
		const tempZipPath = path.join(tmpdir(), `dokploy-upload-${randomUUID()}.zip`);
		const output = createWriteStream(tempZipPath);
		const archive = archiver("zip", {
			zlib: { level: 6 }, // Balanced compression
		});

		let processedBytes = 0;

		// Handle archive events
		output.on("close", () => {
			resolve(tempZipPath);
		});

		archive.on("error", (err) => {
			// Clean up temp file on error
			try {
				fs.unlinkSync(tempZipPath);
			} catch {
				// Ignore cleanup errors
			}
			reject(err);
		});

		archive.on("entry", (entry) => {
			if (progressCallback && entry.stats) {
				processedBytes += entry.stats.size || 0;
				progressCallback({
					processedBytes,
					totalBytes,
					percentage: totalBytes > 0
						? Math.min(Math.round((processedBytes / totalBytes) * 100), 100)
						: 0,
					currentFile: entry.name,
				});
			}
		});

		// Pipe archive to output file
		archive.pipe(output);

		// Add each file to the archive
		for (const file of files) {
			archive.file(file.absolutePath, { name: file.relativePath });
		}

		// Finalize the archive
		archive.finalize();
	});
}

/**
 * Clean up a temporary ZIP file
 */
export function cleanupZipFile(zipPath: string): void {
	try {
		if (fs.existsSync(zipPath)) {
			fs.unlinkSync(zipPath);
		}
	} catch {
		// Ignore cleanup errors
	}
}

/**
 * Get the size of a file in human-readable format
 */
export function formatBytes(bytes: number): string {
	if (bytes === 0) return "0 Bytes";
	const k = 1024;
	const sizes = ["Bytes", "KB", "MB", "GB"];
	const i = Math.floor(Math.log(bytes) / Math.log(k));
	return `${parseFloat((bytes / Math.pow(k, i)).toFixed(2))} ${sizes[i]}`;
}
