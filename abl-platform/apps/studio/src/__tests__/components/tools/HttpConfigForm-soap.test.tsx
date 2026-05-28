/**
 * HttpConfigForm SOAP Protocol Tests
 *
 * Covers U-23..U-26:
 * - U-23: Protocol toggle reveals SOAP fields when switched to SOAP
 * - U-24: Body template switches to SOAP template when protocol switched to SOAP
 * - U-25: Method locked to POST and body type locked to XML when SOAP selected
 * - U-26: Switching back to REST hides SOAP fields and clears soapVersion/soapAction
 */

import React, { useState } from 'react';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { HttpConfigForm, type HttpConfig } from '../../../components/tools/HttpConfigForm';

/**
 * Wrapper that holds HttpConfig state so onChange works.
 */
function HttpConfigHarness({
  initialConfig,
  onConfigChange,
}: {
  initialConfig: HttpConfig;
  onConfigChange?: (config: HttpConfig) => void;
}) {
  const [config, setConfig] = useState(initialConfig);
  return (
    <HttpConfigForm
      config={config}
      onChange={(next) => {
        setConfig(next);
        onConfigChange?.(next);
      }}
      showTemplates={false}
    />
  );
}

const DEFAULT_CONFIG: HttpConfig = {
  endpoint: 'https://example.com/api',
  method: 'GET',
  authType: 'none',
  retryCount: 0,
  retryDelayMs: 1000,
};

describe('HttpConfigForm SOAP Support', () => {
  it('U-23: Protocol toggle reveals SOAP fields when switched to SOAP', async () => {
    const user = userEvent.setup();
    render(<HttpConfigHarness initialConfig={DEFAULT_CONFIG} />);

    // SOAP fields should not be visible initially
    expect(screen.queryByTestId('soap-fields')).not.toBeInTheDocument();

    // Find the protocol select and switch to SOAP
    const protocolTrigger = screen.getByTestId('http-config-protocol');
    await user.click(protocolTrigger);

    // Find the SOAP option in the dropdown
    const soapOption = await screen.findByText('SOAP');
    await user.click(soapOption);

    // SOAP fields should now be visible
    expect(screen.getByTestId('soap-fields')).toBeInTheDocument();
    expect(screen.getByTestId('soap-version-select')).toBeInTheDocument();
    expect(screen.getByTestId('soap-fault-select')).toBeInTheDocument();
  });

  it('U-24: Body template switches to SOAP template when protocol switched to SOAP (empty body)', async () => {
    const user = userEvent.setup();
    let latestConfig: HttpConfig = { ...DEFAULT_CONFIG };

    render(
      <HttpConfigHarness
        initialConfig={{ ...DEFAULT_CONFIG, body: '' }}
        onConfigChange={(c) => {
          latestConfig = c;
        }}
      />,
    );

    // Switch to SOAP
    const protocolTrigger = screen.getByTestId('http-config-protocol');
    await user.click(protocolTrigger);
    const soapOption = await screen.findByText('SOAP');
    await user.click(soapOption);

    // Body should now have the SOAP template since it was empty
    expect(latestConfig.body).toContain('OperationRequest');
    expect(latestConfig.body).toContain('xmlns:ns');
    expect(latestConfig.bodyType).toBe('xml');
  });

  it('U-25: Method locked to POST and body type locked to XML when SOAP selected', async () => {
    const user = userEvent.setup();
    let latestConfig: HttpConfig = { ...DEFAULT_CONFIG };

    render(
      <HttpConfigHarness
        initialConfig={DEFAULT_CONFIG}
        onConfigChange={(c) => {
          latestConfig = c;
        }}
      />,
    );

    // Switch to SOAP
    const protocolTrigger = screen.getByTestId('http-config-protocol');
    await user.click(protocolTrigger);
    const soapOption = await screen.findByText('SOAP');
    await user.click(soapOption);

    // Method should be forced to POST
    expect(latestConfig.method).toBe('POST');

    // The method select should be disabled
    const methodTrigger = screen.getByTestId('http-config-method');
    expect(methodTrigger).toHaveAttribute('data-disabled');

    // Body type should be XML
    expect(latestConfig.bodyType).toBe('xml');

    // A hint about locked method should be visible
    expect(screen.getByText('Method is locked to POST for SOAP tools')).toBeInTheDocument();
  });

  it('U-26: Switching back to REST hides SOAP fields and clears soapVersion/soapAction', async () => {
    const user = userEvent.setup();
    let latestConfig: HttpConfig = { ...DEFAULT_CONFIG };

    render(
      <HttpConfigHarness
        initialConfig={{
          ...DEFAULT_CONFIG,
          protocol: 'soap',
          method: 'POST',
          bodyType: 'xml',
          soapVersion: '1.2',
          soapAction: 'http://example.com/Operation',
          onSoapFault: 'data',
        }}
        onConfigChange={(c) => {
          latestConfig = c;
        }}
      />,
    );

    // SOAP fields should initially be visible
    expect(screen.getByTestId('soap-fields')).toBeInTheDocument();

    // Switch back to REST
    const protocolTrigger = screen.getByTestId('http-config-protocol');
    await user.click(protocolTrigger);
    const restOption = await screen.findByText('REST');
    await user.click(restOption);

    // SOAP fields should be hidden
    expect(screen.queryByTestId('soap-fields')).not.toBeInTheDocument();

    // SOAP-specific fields should be cleared
    expect(latestConfig.soapVersion).toBeUndefined();
    expect(latestConfig.soapAction).toBeUndefined();
    expect(latestConfig.onSoapFault).toBeUndefined();
  });
});
