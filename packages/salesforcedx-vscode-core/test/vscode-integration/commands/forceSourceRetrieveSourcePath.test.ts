/*
 * Copyright (c) 2018, salesforce.com, inc.
 * All rights reserved.
 * Licensed under the BSD 3-Clause license.
 * For full license text, see LICENSE.txt file in the repo root or https://opensource.org/licenses/BSD-3-Clause
 */

import { AuthInfo, Connection } from '@salesforce/core';
import { MockTestOrgData, testSetup } from '@salesforce/core/lib/testSetup';
import {
  CancelResponse,
  ContinueResponse
} from '@salesforce/salesforcedx-utils-vscode/out/src/types/index';
import {
  ComponentSet,
  registry,
  SourceComponent
} from '@salesforce/source-deploy-retrieve';
import { expect } from 'chai';
import * as path from 'path';
import { createSandbox, SinonSandbox, SinonStub } from 'sinon';
import { channelService } from '../../../src/channels';
import {
  ForceSourceRetrieveSourcePathExecutor,
  LibraryRetrieveSourcePathExecutor,
  SourcePathChecker
} from '../../../src/commands';
import { workspaceContext } from '../../../src/context';
import { nls } from '../../../src/messages';
import { notificationService } from '../../../src/notifications';
import { SfdxPackageDirectories, SfdxProjectConfig } from '../../../src/sfdxProject';
import { getRootWorkspacePath } from '../../../src/util';

const sb = createSandbox();
const $$ = testSetup();

describe('Force Source Retrieve with Sourcepath Option', () => {
  describe('CLI Executor', () => {
    it('Should build the source retrieve command', () => {
      const sourcePath = path.join('path', 'to', 'sourceFile');
      const sourceRetrieve = new ForceSourceRetrieveSourcePathExecutor();
      const sourceRetrieveCommand = sourceRetrieve.build(sourcePath);
      expect(sourceRetrieveCommand.toCommand()).to.equal(
        `sfdx force:source:retrieve --sourcepath ${sourcePath}`
      );
      expect(sourceRetrieveCommand.description).to.equal(
        nls.localize('force_source_retrieve_text')
      );
    });
  });

  describe('Library Executor', () => {
    let mockConnection: Connection;
    let retrieveStub: SinonStub;
    let pollStatusStub: SinonStub;

    const defaultPackage = 'test-app';

    beforeEach(async () => {
      const testData = new MockTestOrgData();
      $$.setConfigStubContents('AuthInfoConfig', {
        contents: await testData.getConfig()
      });
      mockConnection = await Connection.create({
        authInfo: await AuthInfo.create({
          username: testData.username
        })
      });
      sb.stub(workspaceContext, 'getConnection').resolves(mockConnection);
      sb.stub(SfdxPackageDirectories, 'getDefaultPackageDir').resolves(
        defaultPackage
      );
      sb.stub(SfdxProjectConfig, 'getValue').resolves('11.0');
      pollStatusStub = sb.stub();
    });

    afterEach(() => {
      sb.restore();
    });

    it('should retrieve with a file path', async () => {
      const executor = new LibraryRetrieveSourcePathExecutor();
      const fsPath = path.join('layouts', 'MyLayout.layout-meta.xml');

      const toRetrieve = new ComponentSet([
        new SourceComponent({
          name: 'MyLayout',
          type: registry.types.layout,
          xml: fsPath
        })
      ]);
      sb.stub(ComponentSet, 'fromSource')
        .withArgs(fsPath)
        .returns(toRetrieve);
      retrieveStub = sb
        .stub(toRetrieve, 'retrieve')
        .returns({ pollStatus: pollStatusStub });

      await executor.run({ data: fsPath, type: 'CONTINUE' });

      expect(retrieveStub.calledOnce).to.equal(true);
      expect(retrieveStub.firstCall.args[0]).to.deep.equal({
        usernameOrConnection: mockConnection,
        output: path.join(getRootWorkspacePath(), defaultPackage),
        merge: true
      });
      expect(pollStatusStub.calledOnce).to.equal(true);
    });

    it('componentSet has sourceApiVersion set', async () => {
      const executor = new LibraryRetrieveSourcePathExecutor();
      const data = path.join(getRootWorkspacePath(), 'force-app/main/default/classes/');
      const continueResponse = {
        type: 'CONTINUE',
        data
      } as ContinueResponse<string>;
      const componentSet = executor.getComponents(continueResponse);
      expect((await componentSet).sourceApiVersion).to.equal('11.0');
    });
  });
});

describe('SourcePathChecker', () => {
  let workspacePath: string;
  let sandboxStub: SinonSandbox;
  let appendLineSpy: SinonStub;
  let showErrorMessageSpy: SinonStub;
  beforeEach(() => {
    sandboxStub = createSandbox();
    workspacePath = getRootWorkspacePath();
    appendLineSpy = sandboxStub.stub(channelService, 'appendLine');
    showErrorMessageSpy = sandboxStub.stub(
      notificationService,
      'showErrorMessage'
    );
  });

  afterEach(() => {
    sandboxStub.restore();
  });

  it('Should continue when source path is in a package directory', async () => {
    const isInPackageDirectoryStub = sandboxStub
      .stub(SfdxPackageDirectories, 'isInPackageDirectory')
      .returns(true);
    const pathChecker = new SourcePathChecker();
    const sourcePath = path.join(workspacePath, 'package');
    const continueResponse = (await pathChecker.check({
      type: 'CONTINUE',
      data: sourcePath
    })) as ContinueResponse<string>;

    expect(isInPackageDirectoryStub.getCall(0).args[0]).to.equal(sourcePath);
    expect(continueResponse.type).to.equal('CONTINUE');
    expect(continueResponse.data).to.equal(sourcePath);

    isInPackageDirectoryStub.restore();
  });

  it('Should notify user and cancel when source path is not inside of a package directory', async () => {
    const isInPackageDirectoryStub = sandboxStub
      .stub(SfdxPackageDirectories, 'isInPackageDirectory')
      .returns(false);
    const pathChecker = new SourcePathChecker();
    const cancelResponse = (await pathChecker.check({
      type: 'CONTINUE',
      data: path.join('not', 'in', 'package', 'directory')
    })) as CancelResponse;

    const errorMessage = nls.localize(
      'error_source_path_not_in_package_directory_text'
    );
    expect(appendLineSpy.getCall(0).args[0]).to.equal(errorMessage);
    expect(showErrorMessageSpy.getCall(0).args[0]).to.equal(errorMessage);
    expect(cancelResponse.type).to.equal('CANCEL');
    isInPackageDirectoryStub.restore();
  });

  it('Should cancel and notify user if an error occurs when fetching the package directories', async () => {
    const isInPackageDirectoryStub = sandboxStub
      .stub(SfdxPackageDirectories, 'isInPackageDirectory')
      .throws(new Error());
    const pathChecker = new SourcePathChecker();
    const cancelResponse = (await pathChecker.check({
      type: 'CONTINUE',
      data: 'test/path'
    })) as CancelResponse;

    const errorMessage = nls.localize(
      'error_source_path_not_in_package_directory_text'
    );
    expect(appendLineSpy.getCall(0).args[0]).to.equal(errorMessage);
    expect(showErrorMessageSpy.getCall(0).args[0]).to.equal(errorMessage);
    expect(cancelResponse.type).to.equal('CANCEL');
    isInPackageDirectoryStub.restore();
  });
});
