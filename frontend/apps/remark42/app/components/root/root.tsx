import { h, Component, Fragment } from 'preact';
import { useEffect } from 'preact/hooks';
import { useSelector } from 'react-redux';
import b from 'bem-react-helper';
import { IntlShape, useIntl, FormattedMessage, defineMessages } from 'react-intl';
import clsx from 'clsx';

import 'styles/global.css';
import type { StoreState } from 'store';
import { COMMENT_NODE_CLASSNAME_PREFIX, MAX_SHOWN_ROOT_COMMENTS, THEMES, IS_MOBILE } from 'common/constants';
import { maxShownComments, noFooter, url } from 'common/settings';

import {
  fetchUser,
  blockUser,
  unblockUser,
  fetchBlockedUsers,
  hideUser,
  unhideUser,
  signout,
} from 'store/user/actions';
import { fetchComments, addComment, updateComment } from 'store/comments/actions';
import { setCommentsReadOnlyState } from 'store/post-info/actions';
import { setTheme } from 'store/theme/actions';

// TODO: make this button as default for all cases and replace current `components/Button`
import { Button } from 'components/auth/components/button';
import { Preloader } from 'components/preloader';
import { Settings } from 'components/settings';
import { AuthPanel } from 'components/auth-panel';
import { SortPicker } from 'components/sort-picker';
import { CommentForm } from 'components/comment-form';
import { Thread } from 'components/thread';
import { ConnectedComment as Comment } from 'components/comment/connected-comment';
import { uploadImage, getPreview } from 'common/api';
import { isUserAnonymous } from 'utils/isUserAnonymous';
import { bindActions } from 'utils/actionBinder';
import { postMessageToParent, parseMessage, updateIframeHeight } from 'utils/post-message';
import { useActions } from 'hooks/useAction';
import { setCollapse } from 'store/thread/actions';

import styles from './root.module.css';

const mapStateToProps = (state: StoreState) => ({
  sort: state.comments.sort,
  isCommentsLoading: state.comments.isFetching,
  user: state.user,
  childToParentComments: Object.entries(state.comments.childComments).reduce(
    (accumulator: Record<string, string>, [key, children]) => {
      children.forEach((child) => (accumulator[child] = key));
      return accumulator;
    },
    {}
  ),
  collapsedThreads: state.collapsedThreads,
  topComments: state.comments.topComments,
  pinnedComments: state.comments.pinnedComments.map((id) => state.comments.allComments[id]).filter((c) => !c.hidden),
  theme: state.theme,
  info: state.info,
  hiddenUsers: state.hiddenUsers,
  blockedUsers: state.bannedUsers,
  getPreview,
  uploadImage,
});

const boundActions = bindActions({
  fetchComments,
  fetchUser,
  fetchBlockedUsers,
  setTheme,
  setCommentsReadOnlyState,
  blockUser,
  unblockUser,
  hideUser,
  unhideUser,
  addComment,
  updateComment,
  setCollapse,
  signout,
});

type Props = ReturnType<typeof mapStateToProps> & typeof boundActions & { intl: IntlShape };

interface State {
  isUserLoading: boolean;
  isSettingsVisible: boolean;
  commentsShown: number;
  wasSomeoneUnblocked: boolean;
}

const messages = defineMessages({
  pinnedComments: {
    id: 'root.pinned-comments',
    defaultMessage: 'Pinned comments',
  },
});

const getCollapsedParent = (hash: string, childToParentComments: Record<string, string>) => {
  let id = hash.replace(`#${COMMENT_NODE_CLASSNAME_PREFIX}`, '');
  while (childToParentComments[id]) {
    id = childToParentComments[id];
  }

  return id;
};

/** main component fr main comments widget */
export class Root extends Component<Props, State> {
  state = {
    isUserLoading: true,
    commentsShown: maxShownComments,
    wasSomeoneUnblocked: false,
    isSettingsVisible: false,
  };

  componentDidMount() {
    const userloading = this.props.fetchUser().finally(() => this.setState({ isUserLoading: false }));

    Promise.all([userloading, this.props.fetchComments()]).finally(() => {
      setTimeout(this.checkUrlHash);
      window.addEventListener('hashchange', this.checkUrlHash);
    });

    window.addEventListener('message', this.onMessage);
  }

  checkUrlHash = (e: Event & { newURL: string }) => {
    const hash = e ? `#${e.newURL.split('#')[1]}` : window.location.hash;

    if (hash.indexOf(`#${COMMENT_NODE_CLASSNAME_PREFIX}`) === 0) {
      if (e) e.preventDefault();

      if (!document.querySelector(hash)) {
        const id = getCollapsedParent(hash, this.props.childToParentComments);
        const indexHash = this.props.topComments.findIndex((item) => item === id);
        const multiplierCollapsed = Math.ceil(indexHash / MAX_SHOWN_ROOT_COMMENTS);
        this.setState(
          {
            commentsShown: this.state.commentsShown + MAX_SHOWN_ROOT_COMMENTS * multiplierCollapsed,
          },
          () => setTimeout(() => this.toMessage(hash), 500)
        );
      } else {
        this.toMessage(hash);
      }
    }
  };

  toMessage = (hash: string) => {
    const comment = document.querySelector(hash);
    if (comment) {
      postMessageToParent({ scrollTo: comment.getBoundingClientRect().top });
      comment.classList.add('comment_highlighting');
      setTimeout(() => {
        comment.classList.remove('comment_highlighting');
      }, 5e3);
    }
  };

  onMessage = (event: MessageEvent) => {
    const data = parseMessage(event);

    if (data.signout === true) {
      this.props.signout(false);
    }

    if (!data.theme || !THEMES.includes(data.theme)) {
      return;
    }

    this.props.setTheme(data.theme);
  };

  onBlockedUsersShow = async () => {
    if (this.props.user && this.props.user.admin) {
      await this.props.fetchBlockedUsers();
    }
    this.setState({ isSettingsVisible: true });
  };

  onBlockedUsersHide = async () => {
    // if someone was unblocked let's reload comments
    if (this.state.wasSomeoneUnblocked) {
      this.props.fetchComments();
    }
    this.setState({
      wasSomeoneUnblocked: false,
      isSettingsVisible: false,
    });
  };

  onUnblockSomeone = () => {
    this.setState({ wasSomeoneUnblocked: true });
  };

  showMore = () => {
    this.setState({
      commentsShown: this.state.commentsShown + MAX_SHOWN_ROOT_COMMENTS,
    });
  };

  render(props: Props, { isUserLoading, commentsShown, isSettingsVisible }: State) {
    if (isUserLoading) {
      return <Preloader className="root__preloader" />;
    }

    const isCommentsDisabled = props.info.read_only!;
    const imageUploadHandler = isUserAnonymous(this.props.user) ? undefined : this.props.uploadImage;

    return (
      <Fragment>
        <AuthPanel
          user={this.props.user}
          hiddenUsers={this.props.hiddenUsers}
          isCommentsDisabled={isCommentsDisabled}
          postInfo={this.props.info}
          signout={this.props.signout}
          onBlockedUsersShow={this.onBlockedUsersShow}
          onBlockedUsersHide={this.onBlockedUsersHide}
          onCommentsChangeReadOnlyMode={this.props.setCommentsReadOnlyState}
        />
        <div className="root__main">
          {isSettingsVisible ? (
            <Settings
              intl={this.props.intl}
              user={this.props.user}
              hiddenUsers={this.props.hiddenUsers}
              blockedUsers={this.props.blockedUsers}
              blockUser={this.props.blockUser}
              unblockUser={this.props.unblockUser}
              hideUser={this.props.hideUser}
              unhideUser={this.props.unhideUser}
              onUnblockSomeone={this.onUnblockSomeone}
            />
          ) : (
            <>
              {!isCommentsDisabled && (
                <CommentForm
                  id={encodeURI(url || '')}
                  intl={this.props.intl}
                  theme={props.theme}
                  mix="root__input"
                  mode="main"
                  user={props.user}
                  onSubmit={(text: string, title: string) => this.props.addComment(text, title)}
                  getPreview={this.props.getPreview}
                  uploadImage={imageUploadHandler}
                />
              )}
              {this.props.pinnedComments.length > 0 && (
                <div
                  className="root__pinned-comments"
                  role="region"
                  aria-label={this.props.intl.formatMessage(messages.pinnedComments)}
                >
                  {this.props.pinnedComments.map((comment) => (
                    <Comment
                      CommentForm={CommentForm}
                      intl={this.props.intl}
                      key={`pinned-comment-${comment.id}`}
                      view="pinned"
                      data={comment}
                      level={0}
                      disabled={true}
                      mix="root__pinned-comment"
                    />
                  ))}
                </div>
              )}
              <div className={clsx('sort-picker', styles.sortPicker)}>
                <SortPicker />
              </div>
              <Comments
                commentsShown={commentsShown}
                isLoading={props.isCommentsLoading}
                topComments={props.topComments}
                showMore={this.showMore}
              />
            </>
          )}
        </div>
      </Fragment>
    );
  }
}

interface CommentsProps {
  isLoading: boolean;
  topComments: string[];
  commentsShown: number;
  showMore(): void;
}
function Comments({ isLoading, topComments, commentsShown, showMore }: CommentsProps) {
  const renderComments =
    IS_MOBILE && commentsShown < topComments.length ? topComments.slice(0, commentsShown) : topComments;
  const isShowMoreButtonVisible = IS_MOBILE && commentsShown < topComments.length;
  if(IS_MOBILE && topComments.length === 0) {
    return (
      <div className={'start_convo__block'}>
        <svg xmlns={"http://www.w3.org/2000/svg"} width={"45"} height={"86"} viewBox={"0 0 45 86"} fill={"none"}>
          <path
            d={"M6.59907 0.639637C6.38387 0.341912 5.96806 0.275016 5.67033 0.490219L0.818636 3.99716C0.520912 4.21236 0.454015 4.62817 0.669219 4.9259C0.884422 5.22362 1.30023 5.29052 1.59796 5.07532L5.91058 1.95803L9.02786 6.27065C9.24306 6.56838 9.65887 6.63528 9.95659 6.42007C10.2543 6.20487 10.3212 5.78906 10.106 5.49133L6.59907 0.639637ZM38.2462 62.2145L38.8946 62.0662L38.2462 62.2145ZM35.4191 84.8853C35.3396 85.244 35.5659 85.5992 35.9245 85.6787C36.2832 85.7582 36.6384 85.5319 36.7179 85.1733L35.4191 84.8853ZM6.05999 1.0293C5.40328 0.923643 5.40324 0.923846 5.40319 0.924189C5.40314 0.924492 5.40306 0.924976 5.40297 0.925581C5.40277 0.926789 5.40249 0.928559 5.40212 0.930886C5.40137 0.935541 5.40027 0.942425 5.39882 0.951507C5.39593 0.969672 5.39165 0.99663 5.38605 1.03213C5.37485 1.10313 5.35838 1.20831 5.33718 1.34565C5.29477 1.62033 5.23345 2.02371 5.15757 2.53975C5.00582 3.57178 4.7958 5.05465 4.56243 6.86004C4.09579 10.47 3.53525 15.3733 3.16064 20.5423C2.78628 25.7078 2.59626 31.1558 2.87534 35.8496C3.01487 38.1964 3.27246 40.3695 3.68823 42.2321C4.10187 44.0851 4.68261 45.6803 5.49825 46.8339L6.58449 46.0659C5.91572 45.12 5.38372 43.7213 4.9866 41.9422C4.59159 40.1727 4.34037 38.0756 4.20332 35.7706C3.92923 31.1607 4.11497 25.7784 4.48748 20.6385C4.85973 15.502 5.41716 10.6248 5.88177 7.03058C6.11402 5.23387 6.32295 3.75873 6.47374 2.73328C6.54913 2.22058 6.60998 1.82035 6.65193 1.54861C6.6729 1.41274 6.68915 1.309 6.70013 1.23939C6.70562 1.20458 6.70979 1.17831 6.71258 1.16082C6.71397 1.15207 6.71502 1.14552 6.71571 1.1412C6.71605 1.13904 6.71631 1.13744 6.71648 1.13639C6.71656 1.13587 6.71662 1.13551 6.71666 1.13525C6.7167 1.13503 6.71671 1.13495 6.05999 1.0293ZM5.49825 46.8339C7.14328 49.1606 9.87434 50.1174 12.8988 50.6007C14.421 50.8439 16.0565 50.9727 17.7197 51.0818C19.3925 51.1915 21.0883 51.2811 22.7742 51.4443C26.1506 51.7713 29.3675 52.3859 31.9817 53.965C34.5623 55.5239 36.6134 58.0586 37.5978 62.3628L38.8946 62.0662C37.8362 57.4381 35.5825 54.5859 32.6695 52.8263C29.79 51.0869 26.3244 50.4516 22.9025 50.1202C21.1892 49.9543 19.4569 49.8626 17.8068 49.7544C16.1472 49.6455 14.565 49.5197 13.1088 49.287C10.1766 48.8185 7.9083 47.9383 6.58449 46.0659L5.49825 46.8339ZM37.5978 62.3628C37.9418 63.8671 37.9937 66.0156 37.8589 68.4406C37.7249 70.8515 37.4099 73.4816 37.0479 75.9228C36.6861 78.3624 36.2787 80.6045 35.9615 82.2371C35.803 83.0531 35.6672 83.7162 35.5711 84.1749C35.523 84.4042 35.4849 84.5824 35.4589 84.7029C35.4458 84.7632 35.4358 84.8091 35.4291 84.8398C35.4258 84.8551 35.4232 84.8666 35.4216 84.8743C35.4207 84.8781 35.4201 84.8809 35.4197 84.8827C35.4195 84.8837 35.4193 84.8843 35.4192 84.8848C35.4192 84.885 35.4192 84.8851 35.4191 84.8852C35.4191 84.8853 35.4191 84.8853 36.0685 85.0293C36.7179 85.1733 36.7179 85.1732 36.718 85.173C36.718 85.1728 36.718 85.1726 36.7181 85.1723C36.7182 85.1717 36.7184 85.1709 36.7187 85.1699C36.7191 85.1677 36.7198 85.1646 36.7207 85.1605C36.7225 85.1523 36.7252 85.1402 36.7287 85.1242C36.7357 85.0924 36.7459 85.0453 36.7592 84.9837C36.7858 84.8607 36.8245 84.6798 36.8731 84.4477C36.9704 83.9835 37.1075 83.3139 37.2674 82.4907C37.5871 80.8449 37.9984 78.5825 38.3638 76.1179C38.7291 73.6549 39.05 70.981 39.1872 68.5145C39.3235 66.0621 39.282 63.7598 38.8946 62.0662L37.5978 62.3628Z"}
            fill={"#7D7D7D"}
          />
        </svg>
        <div>
          <strong>Be the first to comment</strong>
          <br/>
          Let the world know your perspective.
        </div>
      </div>
    )
  }
  return (
    <div className="root__threads" role="list">
      {isLoading ? (
        <Preloader className="root__preloader" />
      ) : (
        <>
          {topComments.length > 0 &&
            renderComments.map((id) => (
              <Thread key={`thread-${id}`} id={id} mix="root__thread" level={0} getPreview={getPreview} />
            ))}
          {isShowMoreButtonVisible && (
            <Button className={clsx('more-comments', styles.moreComments)} onClick={showMore}>
              <FormattedMessage id="root.show-more" defaultMessage="Show more" />
            </Button>
          )}
        </>
      )}
    </div>
  );
}

const CopyrightLink = (title: string) => (
  <a class="root__copyright-link" href="https://remark42.com/">
    {title}
  </a>
);

/** Root component connected to redux */
export function ConnectedRoot() {
  const intl = useIntl();
  const props = useSelector(mapStateToProps);
  const actions = useActions(boundActions);

  useEffect(() => {
    const observer = new ResizeObserver(() => updateIframeHeight());

    updateIframeHeight();
    observer.observe(document.body);
    return () => observer.disconnect();
  }, []);

  return (
    <div className={clsx(b('root', {}, { theme: props.theme }), props.theme)}>
      <Root {...props} {...actions} intl={intl} />
      {!noFooter && (
        <p className="root__copyright" role="contentinfo">
          <FormattedMessage
            id="root.powered-by"
            defaultMessage="Powered by <a>Remark42</a>"
            values={{ a: CopyrightLink }}
          />
        </p>
      )}
    </div>
  );
}
