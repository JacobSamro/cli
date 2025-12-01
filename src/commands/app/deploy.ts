import { Command, Flags } from "@oclif/core";
import { readAuthConfig } from "../../utils/utils.js";
import chalk from "chalk";
import { getProject, getProjects, type Application } from "../../utils/shared.js";
import inquirer from "inquirer";
import type { Answers } from "./create.js";
import axios from "axios";
import FormData from "form-data";
import * as fs from "node:fs";
import * as path from "node:path";
import { createZipFromFolder, cleanupZipFile, formatBytes } from "../../utils/zip.js";

export default class AppDeploy extends Command {
	static description = "Deploy an application to a project. Supports both remote repository deployments and local folder uploads.";

	static examples = [
		"$ <%= config.bin %> app deploy",
		"$ <%= config.bin %> app deploy --applicationId myAppId",
		"$ <%= config.bin %> app deploy --from-folder ./my-app --applicationId myAppId",
		"$ <%= config.bin %> app deploy --from-folder ./my-app --build-path /app",
		"$ DOKPLOY_URL=xxx DOKPLOY_AUTH_TOKEN=xxx <%= config.bin %> app deploy --applicationId myAppId"
	];

	static flags = {
		applicationId: Flags.string({
			char: 'a',
			description: 'ID of the application to deploy',
			required: false,
		}),
		projectId: Flags.string({
			char: 'p',
			description: 'ID of the project',
			required: false,
		}),
		environmentId: Flags.string({
			char: 'e',
			description: 'ID of the environment',
			required: false,
		}),
		skipConfirm: Flags.boolean({
			char: 'y',
			description: 'Skip confirmation prompt',
			default: false,
		}),
		'from-folder': Flags.string({
			char: 'f',
			description: 'Path to local folder to deploy (uploads folder as ZIP)',
			required: false,
		}),
		'build-path': Flags.string({
			char: 'b',
			description: 'Build path within the uploaded folder (e.g., /app or /src)',
			required: false,
			default: '',
		}),
	};

	public async run(): Promise<void> {
		const auth = await readAuthConfig(this);
		const { flags } = await this.parse(AppDeploy);
		let { projectId, applicationId, environmentId } = flags;
		const fromFolder = flags['from-folder'];
		const buildPath = flags['build-path'];

		// Interactive mode only if applicationId is not provided
		// (projectId and environmentId are only needed for interactive selection)
		if (!applicationId) {
			console.log(chalk.blue.bold("\n  Listing all Projects \n"));
			const projects = await getProjects(auth, this);

			let selectedProject;
			let selectedEnvironment;

			// 1. Select project
			if (!projectId) {
				const { project } = await inquirer.prompt<Answers>([
					{
						choices: projects.map((project) => ({
							name: project.name,
							value: project,
						})),
						message: "Select a project to deploy the application from:",
						name: "project",
						type: "list",
					},
				]);
				selectedProject = project;
				projectId = project.projectId;
			} else {
				selectedProject = projects.find(p => p.projectId === projectId);
			}

			// 2. Select environment
			if (!environmentId) {
				if (!selectedProject?.environments || selectedProject.environments.length === 0) {
					this.error(chalk.yellow("No environments found in this project."));
				}

				const { environment } = await inquirer.prompt([
					{
						choices: selectedProject.environments.map((env) => ({
							name: `${env.name} (${env.description})`,
							value: env,
						})),
						message: "Select an environment:",
						name: "environment",
						type: "list",
					},
				]);
				selectedEnvironment = environment;
				environmentId = environment.environmentId;
			} else {
				selectedEnvironment = selectedProject?.environments?.find(e => e.environmentId === environmentId);
			}

			// 3. Select application
			if (!selectedEnvironment?.applications || selectedEnvironment.applications.length === 0) {
				this.error(chalk.yellow("No applications found in this environment."));
			}

			const appAnswers = await inquirer.prompt([
				{
					choices: selectedEnvironment.applications.map((app: Application) => ({
						name: app.name,
						value: app.applicationId,
					})),
					message: "Select the application to deploy:",
					name: "selectedApp",
					type: "list",
				},
			]);
			applicationId = appAnswers.selectedApp;
		}

		// If --from-folder is specified, use drop deployment
		if (fromFolder) {
			await this.deployFromFolder(auth, applicationId!, fromFolder, buildPath || '', flags.skipConfirm);
		} else {
			await this.deployFromRepository(auth, applicationId!, flags.skipConfirm);
		}
	}

	/**
	 * Deploy from a local folder by uploading it as a ZIP file
	 */
	private async deployFromFolder(
		auth: { url: string; token: string },
		applicationId: string,
		folderPath: string,
		buildPath: string,
		skipConfirm: boolean
	): Promise<void> {
		// Resolve and validate folder path
		const resolvedPath = path.resolve(folderPath);

		if (!fs.existsSync(resolvedPath)) {
			this.error(chalk.red(`Folder does not exist: ${resolvedPath}`));
		}

		const stats = fs.statSync(resolvedPath);
		if (!stats.isDirectory()) {
			this.error(chalk.red(`Path is not a directory: ${resolvedPath}`));
		}

		this.log(chalk.blue(`\nPreparing to deploy from: ${resolvedPath}`));

		// Confirmation prompt
		if (!skipConfirm) {
			const confirmAnswers = await inquirer.prompt([
				{
					default: false,
					message: `Are you sure you want to deploy from folder "${path.basename(resolvedPath)}"?`,
					name: "confirmDeploy",
					type: "confirm",
				},
			]);

			if (!confirmAnswers.confirmDeploy) {
				this.error(chalk.yellow("Deployment cancelled."));
			}
		}

		let zipPath: string | null = null;

		try {
			// Step 1: Create ZIP archive
			this.log(chalk.cyan("Creating ZIP archive..."));

			const startTime = Date.now();
			let lastLogTime = 0;

			zipPath = await createZipFromFolder(resolvedPath, (progress) => {
				const now = Date.now();
				// Log progress every 500ms to avoid spamming
				if (now - lastLogTime > 500) {
					process.stdout.write(
						`\r${chalk.cyan("Compressing:")} ${progress.percentage}% - ${progress.currentFile || "..."}`
					);
					lastLogTime = now;
				}
			});

			const zipStats = fs.statSync(zipPath);
			const compressionTime = ((Date.now() - startTime) / 1000).toFixed(1);

			this.log(`\r${chalk.green("ZIP created:")} ${formatBytes(zipStats.size)} in ${compressionTime}s`);

			// Check file size (max 2GB)
			const maxSize = 2 * 1024 * 1024 * 1024; // 2GB
			if (zipStats.size > maxSize) {
				this.error(chalk.red(`ZIP file is too large (${formatBytes(zipStats.size)}). Maximum allowed size is 2GB.`));
			}

			// Step 2: Upload ZIP file
			this.log(chalk.cyan("Uploading to Dokploy server..."));

			const formData = new FormData();
			formData.append("zip", fs.createReadStream(zipPath), {
				filename: "upload.zip",
				contentType: "application/zip",
			});
			formData.append("applicationId", applicationId);
			if (buildPath) {
				formData.append("dropBuildPath", buildPath);
			}

			const uploadStartTime = Date.now();
			let lastUploadLog = 0;

			const response = await axios.post(
				`${auth.url}/api/trpc/application.dropDeployment`,
				formData,
				{
					headers: {
						...formData.getHeaders(),
						"x-api-key": auth.token,
					},
					maxContentLength: Infinity,
					maxBodyLength: Infinity,
					onUploadProgress: (progressEvent) => {
						const now = Date.now();
						if (now - lastUploadLog > 200) {
							const percentCompleted = progressEvent.total
								? Math.round((progressEvent.loaded * 100) / progressEvent.total)
								: 0;
							process.stdout.write(
								`\r${chalk.cyan("Uploading:")} ${percentCompleted}% (${formatBytes(progressEvent.loaded)})`
							);
							lastUploadLog = now;
						}
					},
				}
			);

			const uploadTime = ((Date.now() - uploadStartTime) / 1000).toFixed(1);

			if (response.status === 200) {
				this.log(`\r${chalk.green("Upload complete!")} (${uploadTime}s)                    `);
				this.log(chalk.green.bold("\nDeployment triggered successfully!"));
				this.log(chalk.dim("The application is now being built and deployed."));
				this.log(chalk.dim("Check your Dokploy dashboard for deployment status."));
			} else {
				this.error(chalk.red(`Deployment failed with status: ${response.status}`));
			}
		} catch (error: any) {
			if (error.response?.data?.error?.message) {
				this.error(chalk.red(`Deployment error: ${error.response.data.error.message}`));
			} else if (error.response?.status === 401) {
				this.error(chalk.red("Authentication failed. Please check your API token."));
			} else if (error.response?.status === 403) {
				this.error(chalk.red("Access denied. You may not have permission to deploy this application."));
			} else if (error.response?.status === 404) {
				this.error(chalk.red("Application not found. Please check the application ID."));
			} else {
				this.error(chalk.red(`Deployment error: ${error.message}`));
			}
		} finally {
			// Cleanup temporary ZIP file
			if (zipPath) {
				cleanupZipFile(zipPath);
			}
		}
	}

	/**
	 * Deploy from the configured remote repository
	 */
	private async deployFromRepository(
		auth: { url: string; token: string },
		applicationId: string,
		skipConfirm: boolean
	): Promise<void> {
		// Confirmation prompt
		if (!skipConfirm) {
			const confirmAnswers = await inquirer.prompt([
				{
					default: false,
					message: "Are you sure you want to deploy this application?",
					name: "confirmDelete",
					type: "confirm",
				},
			]);

			if (!confirmAnswers.confirmDelete) {
				this.error(chalk.yellow("Application deployment cancelled."));
			}
		}

		try {
			const response = await axios.post(
				`${auth.url}/api/trpc/application.deploy`,
				{
					json: {
						applicationId,
					},
				},
				{
					headers: {
						"x-api-key": auth.token,
						"Content-Type": "application/json",
					},
				},
			);

			if (response.status !== 200) {
				this.error(chalk.red("Error deploying application"));
			}
			this.log(chalk.green("Application deploy successful."));
		} catch (error: any) {
			this.error(chalk.red(`Error deploying application: ${error.message}`));
		}
	}
}
