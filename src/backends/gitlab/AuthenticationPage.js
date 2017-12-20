import PropTypes from 'prop-types';
import React from 'react';
import { Icon } from 'UI';

export default class AuthenticationPage extends React.Component {
  static propTypes = {
    onLogin: PropTypes.func.isRequired,
    base_url: PropTypes.string,
    inProgress: PropTypes.bool,
  };

  state = {};

  handshakeCallback = (e) => {
    if (this.authWindow) {
      const match = this.authWindow.location.href.match(/access_token=([^&]+)/);
      if (match) {
        this.props.onLogin({ token: match[1] });
        this.authWindow.close();
      }
    }
  };

  handleLogin = (e) => {
    e.preventDefault();
    const left = (screen.width / 2) - (960 / 2);
    const top = (screen.height / 2) - (600 / 2);
    this.authWindow = window.open(
      this.props.base_url,
      'GitLab Authorization',
      'toolbar=no, location=no, directories=no, status=no, menubar=no, scrollbars=no, resizable=no, copyhistory=no, ' +
      ('width=' + 960 + ', height=' + 600 + ', top=' + top + ', left=' + left + ');')
    );
    this.authWindow.addEventListener('message', this.handshakeCallback, false);
    this.authWindow.focus();

    // auth.authenticate({ provider: 'gitlab', scope: 'repo' }, (err, data) => {
    //   if (err) {
    //     this.setState({ loginError: err.toString() });
    //     return;
    //   }
    //   this.props.onLogin(data);
    // });
  };

  render() {
    const { loginError } = this.state;
    const { inProgress } = this.props;

    return (
      <section className="nc-gitlabAuthenticationPage-root">
        <Icon className="nc-gitlabAuthenticationPage-logo" size="500px" type="netlify-cms"/>
        {loginError && <p>{loginError}</p>}
        <button
          className="nc-gitlabAuthenticationPage-button"
          disabled={inProgress}
          onClick={this.handleLogin}
        >
          <Icon type="github" /> {inProgress ? "Logging in..." : "Login with GitLab"}
        </button>
      </section>
    );
  }
}
