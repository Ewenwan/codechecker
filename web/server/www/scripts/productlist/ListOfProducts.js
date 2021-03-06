// -------------------------------------------------------------------------
//                     The CodeChecker Infrastructure
//   This file is distributed under the University of Illinois Open Source
//   License. See LICENSE.TXT for details.
// -------------------------------------------------------------------------

define([
  'dojo/_base/declare',
  'dojo/dom-class',
  'dojo/dom',
  'dojo/dom-construct',
  'dojo/data/ItemFileWriteStore',
  'dojo/topic',
  'dojox/grid/DataGrid',
  'dijit/ConfirmDialog',
  'dijit/Dialog',
  'dijit/form/Button',
  'dijit/form/TextBox',
  'dijit/layout/ContentPane',
  'codechecker/util',
  'products/PermissionList',
  'products/ProductSettingsView',
  'products/NotificationView'],
function (declare, domClass, domBase, dom, ItemFileWriteStore, topic, DataGrid,
  ConfirmDialog, Dialog, Button, TextBox, ContentPane, util, PermissionList,
  ProductSettingsView, NotificationView) {

  var NotificationDialog = declare(ConfirmDialog, {
    constructor : function() {
      this.notificationView = new NotificationView();
    },

    onExecute : function() {
      var node = domBase.byId('notification-text');
        if(node){
          var input = this.notificationView._txtAlert.get('value');
          node.innerHTML = input;
          try {
            CC_CONF_SERVICE.setNotificationBannerText(util.utoa(input));
          } catch (ex) { util.handleThriftException(ex); }
        }
    },

    postCreate : function() {
      this.inherited(arguments);
      this.addChild(this.notificationView);
    }

  });
  //--- Global (server-wide) permission configuration dialog ---//

  var SystemPermissionsDialog = declare(ConfirmDialog, {
    constructor : function () {
      this.permissionView = new PermissionList();

      this._dialog = new Dialog({
        title : "Some permission changes failed to be saved."
      });
    },

    onExecute : function () {
      var errors = [];
      var permDiff = this.permissionView.getPermissionDifference();
      permDiff.forEach(function (record) {
       try {
          if (record.action === 'ADD') {
            var authName = record.name.trim();
            CC_AUTH_SERVICE.addPermission(
              record.permission, authName, record.isGroup, "");
          } else if (record.action === 'REMOVE') {
            CC_AUTH_SERVICE.removePermission(
              record.permission, record.name, record.isGroup, "");
          }
        }
        catch (exc) {
          errors.push(record);
          util.handleThriftException(exc);
        }
      });

      if (errors.length > 0) {
        var text = "<ul>";
        errors.forEach(function(record) {
          var permissionName = util.enumValueToKey(Permission,
                                                   record.permission);
          text += '<li><strong>' + (record.action === 'ADD' ? "Add" : "Remove") +
                  '</strong> permission <strong>' + permissionName +
                  '</strong> of ' + (record.isGroup ? "group" : "user") +
                  ' <strong>' + record.name + '</strong>.</li>\n';
        });
        text += '</ul>';
        this._dialog.set('content', text);
        this._dialog.show();
      }
    },

    populatePermissions : function() {
      this.permissionView.populatePermissions('SYSTEM', {});
    },

    postCreate : function () {
      this.inherited(arguments);
      this.addChild(this.permissionView);
    }
  });

  //--- Product delete confirmation dialog ---//

  var DeleteProductDialog = declare(ConfirmDialog, {
    constructor : function () {
      this._confirmLabel = new ContentPane({
        class : 'deleteConfirmText',
        innerHTML : '<span class="warningHeader">You have selected to ' +
                    'delete a product!</span><br \><br \>' +
                    "Deleting a product <strong>will</strong> remove " +
                    "product-specific configuration, such as access " +
                    "control and authorisation settings, and " +
                    "<strong>will</strong> disconnect the database from " +
                    "the server.<br \><br \>Analysis results stored in " +
                    "the database <strong>will NOT</strong> be lost!"
      });
    },

    onCancel : function () {
      this.productGrid.set('deleteProductID', null);
    },

    onExecute : function () {
      var that = this;

      if (this.productGrid.deleteProductID) {
        CC_PROD_SERVICE.removeProduct(
          this.productGrid.deleteProductID,
          function (success) {
            that.productGrid.store.fetch({
              onComplete : function (products) {
                products.forEach(function (product) {
                  if (product.id[0] === that.productGrid.deleteProductID)
                    that.productGrid.store.deleteItem(product);
                });
              }
            });
          }).fail(function (xhr) { util.handleAjaxFailure(xhr); });
      }
    },

    postCreate : function () {
      this.inherited(arguments);
      this.connect(this.content.cancelButton, "onClick", "onCancel");

      this.addChild(this._confirmLabel);
    }
  });

  //--- Product grid ---//

  function formatProductStatus(item) {
    if (!item.accessible) {
      return '<span class="customIcon product-noaccess"></span>';
    } else if (item.databaseStatus !== DBStatus.OK) {
      return '<span class="customIcon product-error"></span>';
    }
    return '';
  }

  function formatProductIcon(item) {
    var name = util.atou(item.displayedName_b64);

    return '<div class="product-avatar" '
      + 'style="background-color: '
      + util.strToColorBlend(item.endpoint, "white", 0.75).toHex() + '">'
      + '<span class="product-avatar">'
      + name[0].toUpperCase()
      + '</span></div>';
  }

  function formatProductName(item) {
    var name = util.atou(item.displayedName_b64);

    if (item.databaseStatus !== DBStatus.OK || !item.accessible) {
      return '<span class="product-error">' + name + '</span>';
    } else {
      return '<span class="link">' + name + '</span>';
    }
  }

  function formatProductDescription(item) {
    var description = item.description_b64
                      ? util.atou(item.description_b64)
                      : "";

      var dbStatus = item.databaseStatus;
      var dbStatusMsg = util.dbStatusFromCodeToString(dbStatus);

      if (!item.accessible) {
        return '<span class="product-description-error access">'
          + 'You do not have access to this product!'
          + '</span><br />' + description;
      } else if (dbStatus !== DBStatus.OK) {
          var upgradeMsg = '';

          if(dbStatus === DBStatus.SCHEMA_MISMATCH_OK ||
             dbStatus === DBStatus.SCHEMA_MISSING) {
            upgradeMsg = ' (use <kbd>server</kbd> command for schema '
                          + 'upgrade/initialization)';
          }
        return '<span class="product-description-error database">'
          + dbStatusMsg + upgradeMsg + '</span><br />' + description ;
      }
      return description;
  }

  var ListOfProductsGrid = declare(DataGrid, {
    constructor : function () {
      this.store = new ItemFileWriteStore({
        data : { identifier : 'endpoint', items : [] }
      });

      // TODO: Support access control for products and handle locks well.
      // TODO: Support showing the last checkin's information for products.
      this.structure = [
        { name : '&nbsp;', field : 'status', cellClasses : 'status', formatter : formatProductStatus, width : '20px', noresize : true },
        { name : '&nbsp;', field : 'icon', cellClasses : 'product-icon', formatter : formatProductIcon, width : '40px', noresize : true },
        { name : 'Name', field : 'name', cellClasses : 'product-name', formatter : formatProductName, width : '25%' },
        { name : 'Description', field : 'description', formatter : formatProductDescription, styles : 'text-align: left;', width : '70%' },
        { name : 'Admins', field : 'admins', styles : 'text-align: left;', width : '70%' },
        { name : 'Number of runs', field : 'runCount', styles : 'text-align: center;', width : '25%' },
        { name : 'Latest store to product', field : 'latestStoreToProduct', styles : 'text-align: center;', width : '25%' },
        { name : 'Run store in progress', field : 'runStoreInProgress', styles : 'text-align: center;', width : '25%' },
        { name : '&nbsp;', field : 'editIcon', cellClasses : 'status', width : '20px', noresize : true},
        { name : '&nbsp;', field : 'deleteIcon', cellClasses : 'status', width : '20px', noresize : true}
      ];

      this.focused = true;
      this.selectable = true;
      this.keepSelection = true;
      this.escapeHTMLInData = false;
      this.sortInfo = '+3';
      this.store.comparatorMap = {
        'name' : function (itemA, itemB) {
          // Case insensitive sort.
          var nameA = util.atou(itemA.displayedName_b64);
          var nameB = util.atou(itemB.displayedName_b64);
          return nameA.toLowerCase().localeCompare(nameB.toLowerCase());
        },
        'description' : function (itemA, itemB) {
          // Case insensitive sort.
          var descriptionA = itemA.description_b64
            ? util.atou(itemA.description_b64)
            : '';
          var descriptionB = itemB.description_b64
            ? util.atou(itemB.description_b64)
            : '';

          return descriptionA.toLowerCase().localeCompare(
            descriptionB.toLowerCase());
        }
      };
    },

    postCreate : function () {
      this.inherited(arguments);
      this._populateProducts();
    },

    canSort : function (inSortInfo) {
      var cell = this.getCell(Math.abs(inSortInfo) - 1);

      return cell.field === 'name' ||
             cell.field === 'description' ||
             cell.field === 'runCount' ||
             cell.field === 'latestStoreToProduct';
    },

    onRowClick : function (evt) {
      var item = this.getItem(evt.rowIndex);
      switch (evt.cell.field) {
        case 'name':
          if (item.databaseStatus[0] === DBStatus.OK && item.accessible[0]) {
            window.open('/' + item.endpoint[0], '_self');
          }
          break;
        case 'editIcon':
          if (this.adminLevel >= 1 && item.administrating[0]) {
            // User needs to have at least PRODUCT_ADMIN level and the admin
            // options turned on, and must also be an admin of the product
            // clicked.
            var that = this;
            that.productSettingsView.setMode(
              that.get('adminLevel'), 'edit', item.id[0],
              function () {
                // Reapply the product list filtering.
                that.infoPane._executeFilter(
                  that.infoPane._productFilter.get('value'));
            });

            this.productSettingsView.show();
          }
          break;
        case 'deleteIcon':
          if (this.adminLevel >= 2) { // at least SUPERUSER
            this.set('deleteProductID', item.id[0]);
            this.confirmDeleteDialog.show();
          }
          break;
      }
    },

    _addProductData : function (item) {
      this.store.newItem({
        status : item,
        icon : item,
        id : item.id,
        endpoint : item.endpoint,
        name : item,
        description : item,
        databaseStatus : item.databaseStatus,
        accessible : item.accessible,
        administrating : item.administrating,
        runCount : item.databaseStatus === DBStatus.OK ? item.runCount : 0,
        admins : item.admins ? item.admins.join(', ') : null,
        latestStoreToProduct : util.prettifyDate(item.latestStoreToProduct),
        runStoreInProgress : item.runStoreInProgress.join(', '),
        editIcon : '',
        deleteIcon : ''
      });
    },

    _populateProducts : function (productNameFilter) {
      var that = this;

      CC_PROD_SERVICE.getProducts(null, productNameFilter,
      function (productList) {
        productList.forEach(function (item) {
          that._addProductData(item);
        });

        that.productsPane.set('tabCount', productList.length);
        that.onLoaded(productList);
      }).fail(function (xhr) { util.handleAjaxFailure(xhr); });
    },

    /**
     * This function refreshes grid with available product data based on
     * text name filter.
     */
    refreshGrid : function (productNameFilter) {
      var that = this;

      this.store.fetch({
        onComplete : function (products) {
          products.forEach(function (product) {
            that.store.deleteItem(product);
          });
          that.store.save();
        }
      });

      this._populateProducts('*' + productNameFilter + '*');
    },

    toggleAdminButtons : function (adminLevel) {
      this.set('adminLevel', adminLevel);
      var that = this;

      this.store.fetch({
        onComplete : function (products) {
          products.forEach(function (product) {
            if (adminLevel >= 1 && product.administrating[0])
              that.store.setValue(product, 'editIcon',
                '<span class="customIcon product-edit"></span>');
            else
              that.store.setValue(product, 'editIcon', '');

            if (adminLevel >= 2)
              that.store.setValue(product, 'deleteIcon',
                '<span class="customIcon product-delete"></span>');
            else
              that.store.setValue(product, 'deleteIcon', '');
          });
        }
      });
    },

    onLoaded : function (productDataList) {
      var that = this;

      this.toggleAdminButtons(this.adminLevel);
      setTimeout(function () { that.sort(); }, 0);
    }
  });

  //--- Grid top bar ---//

  var ProductInfoPane = declare(ContentPane, {
    _executeFilter : function (filter) {
      var that = this;

      clearTimeout(this._timer);
      this._timer = setTimeout(function () {
        that.listOfProductsGrid.refreshGrid(filter);
      }, 500);
    },

    postCreate : function () {
      var that = this;

      //--- Product filter ---//

      this._productFilter = new TextBox({
        placeHolder : 'Search for products...',
        onKeyUp    : function (evt) {
          that._executeFilter(this.get('value'));
        }
      });
      this.addChild(this._productFilter);

      var rightBtnWrapper = dom.create("div", {
        style : "float:right"
      }, this.domNode);

      //--- Edit Notification header button ---//

      this._sysNotifBtn = new Button({
        label    : 'Edit announcement',
        class    : 'system-perms-btn invisible',
        onClick  : function () {
          that.notificationDialog.show();
        }
      });
      dom.place(this._sysNotifBtn.domNode, rightBtnWrapper);


      //--- Edit permissions button ---//

      this._sysPermsBtn = new Button({
        label    : 'Edit global permissions',
        class    : 'system-perms-btn invisible',
        onClick  : function () {
          that.systemPermissionsDialog.populatePermissions();
          that.systemPermissionsDialog.show();
        }
      });
      dom.place(this._sysPermsBtn.domNode, rightBtnWrapper);

      //--- New product button ---//

      this._newBtn = new Button({
        label    : 'Create new product',
        class    : 'new-btn invisible',
        onClick  : function () {
          that.productSettingsView.setMode(
            that.get('adminLevel'), 'add', null,
            function () {
              // Reapply the product list filtering.
              that._executeFilter(that._productFilter.get('value'));

              // When a product is successfully added, hide the dialog.
              that.productSettingsView.hide();
          });
          that.productSettingsView.show();
        }
      });
      dom.place(this._newBtn.domNode, rightBtnWrapper);
    },

    toggleAdminButtons : function (adminLevel) {
      this.set('adminLevel', adminLevel);

      // Permissions and new product can only be clicked if SUPERUSER.
      domClass.toggle(this._sysNotifBtn.domNode, 'invisible', adminLevel < 2);
      domClass.toggle(this._sysPermsBtn.domNode, 'invisible', adminLevel < 2);
      domClass.toggle(this._newBtn.domNode, 'invisible', adminLevel < 2);
    }
  });

  //--- Main view ---//

  return declare(ContentPane, {
    postCreate : function () {
      this.infoPane = new ProductInfoPane({ id : 'product-infopane' });

      this.listOfProductsGrid = new ListOfProductsGrid({
        id : 'productGrid',
        infoPane : this.infoPane,
        productsPane : this.productsPane
      });

      this.infoPane.set('listOfProductsGrid', this.listOfProductsGrid);

      this.addChild(this.infoPane);
      this.addChild(this.listOfProductsGrid);

      //--- Initialise auxiliary GUI elements ---//

      var confirmDeleteDialog = new DeleteProductDialog({
        title       : 'Confirm deletion of product',
        productGrid : this.listOfProductsGrid
      });

      this.listOfProductsGrid.set('confirmDeleteDialog', confirmDeleteDialog);

      var productSettingsView = new ProductSettingsView({
        title       : 'Product settings',
        productGrid : this.listOfProductsGrid
      });

      this.infoPane.set('productSettingsView', productSettingsView);
      this.listOfProductsGrid.set('productSettingsView', productSettingsView);

      var notificationDialog = new NotificationDialog();
      this.infoPane.set('notificationDialog', notificationDialog);

      var systemPermissionsDialog = new SystemPermissionsDialog({
        title  : 'Global permissions'
      });

      this.infoPane.set('systemPermissionsDialog', systemPermissionsDialog);
    },

    setAdmin : function (adminLevel) {
      this.infoPane.toggleAdminButtons(adminLevel);
      this.listOfProductsGrid.toggleAdminButtons(adminLevel);
    }
  });
});
