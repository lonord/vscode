/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

'use strict';

import { IDraggedResource } from 'vs/workbench/browser/editor';
import { WORKSPACE_EXTENSION, IWorkspacesService } from 'vs/platform/workspaces/common/workspaces';
import { extname } from 'vs/base/common/paths';
import { IFileService } from 'vs/platform/files/common/files';
import { IWindowsService, IWindowService } from 'vs/platform/windows/common/windows';
import URI from 'vs/base/common/uri';
import { ITextFileService } from 'vs/workbench/services/textfile/common/textfiles';
import { BACKUP_FILE_RESOLVE_OPTIONS, IBackupFileService } from 'vs/workbench/services/backup/common/backup';
import { IEditorGroupService } from 'vs/workbench/services/group/common/groupService';
import { TPromise } from 'vs/base/common/winjs.base';
import { Schemas } from 'vs/base/common/network';
import { IUntitledEditorService } from 'vs/workbench/services/untitled/common/untitledEditorService';

/**
 * Shared function across some editor components to handle drag & drop of external resources. E.g. of folders and workspace files
 * to open them in the window instead of the editor or to handle dirty editors being dropped between instances of Code.
 */
export class EditorAreaDropHandler {

	constructor(
		private resources: IDraggedResource[],
		@IFileService private fileService: IFileService,
		@IWindowsService private windowsService: IWindowsService,
		@IWindowService private windowService: IWindowService,
		@IWorkspacesService private workspacesService: IWorkspacesService,
		@ITextFileService private textFileService: ITextFileService,
		@IBackupFileService private backupFileService: IBackupFileService,
		@IEditorGroupService private editorGroupService: IEditorGroupService,
		@IUntitledEditorService private untitledEditorService: IUntitledEditorService
	) {
	}

	public handleDrop(): TPromise<boolean /* handled */> {
		return this.doHandleDrop().then(isWorkspaceOpening => {

			// Add external ones to recently open list unless dropped resource is a workspace
			if (!isWorkspaceOpening) {
				const externalResources = this.resources.filter(d => d.isExternal).map(d => d.resource);
				if (externalResources.length) {
					this.windowsService.addRecentlyOpened(externalResources.map(resource => resource.fsPath));
				}
			}

			return isWorkspaceOpening;
		});
	}

	private doHandleDrop(): TPromise<boolean> {

		// Check for dirty editor being dropped
		if (this.resources.length === 1 && !this.resources[0].isExternal && this.resources[0].backupResource) {
			return this.handleDirtyEditorDrop();
		}

		// Check for external file drop operation from another program or the OS
		if (this.resources.some(r => r.isExternal)) {
			return this.handleExternalDrop();
		}

		return TPromise.as(false);
	}

	private handleDirtyEditorDrop(): TPromise<boolean> {
		const droppedDirtyResource = this.resources[0];

		// Untitled: always ensure that we open a new untitled for each file we drop
		if (droppedDirtyResource.resource.scheme === Schemas.untitled) {
			droppedDirtyResource.resource = this.untitledEditorService.createOrGet().getResource();
		}

		// Return early if the resource is already dirty in target or opened already
		if (this.textFileService.isDirty(droppedDirtyResource.resource) || this.editorGroupService.getStacksModel().isOpen(droppedDirtyResource.resource)) {
			return TPromise.as(false);
		}

		// Resolve the contents of the dropped dirty resource from source
		return this.textFileService.resolveTextContent(droppedDirtyResource.backupResource, BACKUP_FILE_RESOLVE_OPTIONS).then(content => {

			// Set the contents of to the resource to the target
			return this.backupFileService.backupResource(droppedDirtyResource.resource, this.backupFileService.parseBackupContent(content.value));
		}).then(() => false, () => false /* ignore any error */);
	}

	private handleExternalDrop(): TPromise<boolean> {
		const externalResources = this.resources.filter(d => d.isExternal).map(d => d.resource);

		const externalWorkspaceResources: { workspaces: URI[], folders: URI[] } = {
			workspaces: [],
			folders: []
		};

		return TPromise.join(externalResources.map(resource => {

			// Check for Workspace
			if (extname(resource.fsPath) === `.${WORKSPACE_EXTENSION}`) {
				externalWorkspaceResources.workspaces.push(resource);

				return void 0;
			}

			// Check for Folder
			return this.fileService.resolveFile(resource).then(stat => {
				if (stat.isDirectory) {
					externalWorkspaceResources.folders.push(stat.resource);
				}
			}, error => void 0);
		})).then(_ => {
			const { workspaces, folders } = externalWorkspaceResources;

			// Return early if no external resource is a folder or workspace
			if (workspaces.length === 0 && folders.length === 0) {
				return false;
			}

			// Pass focus to window
			this.windowService.focusWindow();

			let workspacesToOpen: TPromise<string[]>;

			// Open in separate windows if we drop workspaces or just one folder
			if (workspaces.length > 0 || folders.length === 1) {
				workspacesToOpen = TPromise.as([...workspaces, ...folders].map(resources => resources.fsPath));
			}

			// Multiple folders: Create new workspace with folders and open
			else if (folders.length > 1) {
				workspacesToOpen = this.workspacesService.createWorkspace(folders.map(folder => ({ uri: folder }))).then(workspace => [workspace.configPath]);
			}

			// Open
			workspacesToOpen.then(workspaces => {
				this.windowsService.openWindow(workspaces, { forceReuseWindow: true });
			});

			return true;
		});
	}
}